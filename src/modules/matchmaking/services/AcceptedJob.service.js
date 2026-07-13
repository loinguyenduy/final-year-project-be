import { fn, col } from 'sequelize';
import db from '../../../core/database/connection.js';
import Review from '../../dispute/models/Review.model.js';
import Transaction from '../../fintech/models/Transaction.model.js';
import Wallet from '../../fintech/models/Wallet.model.js';
import HandymanProfile from '../../identity/models/HandymanProfile.model.js';
import User from '../../identity/models/User.model.js';
import Bid from '../models/Bid.model.js';
import Job from '../models/Job.model.js';
import JobCancellation from '../models/JobCancellation.model.js';
import JobStatusHistory from '../models/JobStatusHistory.model.js';
import Service from '../models/Service.model.js';

const serviceError = (EM, EC, code, DT = '') => ({ EM, EC, code, DT });
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isValidUuid = (value) => UUID_PATTERN.test(String(value || ''));

const toNumber = (value) => Number(value || 0);

const getPartnerMetrics = async (userId, role, options = {}) => {
    const reviewSummary = await Review.findOne({
        attributes: [
            [fn('AVG', col('rating_stars')), 'rating'],
            [fn('COUNT', col('id')), 'review_count']
        ],
        where: { reviewee_id: userId },
        raw: true,
        ...options
    });

    const reviewCount = Number(reviewSummary?.review_count || 0);
    const rating = reviewCount > 0
        ? Number(Number(reviewSummary.rating).toFixed(1))
        : null;

    let completedCount = 0;
    let cancelledCount = 0;

    if (role === 'HANDYMAN') {
        [completedCount, cancelledCount] = await Promise.all([
            Job.count({
                where: { selected_handyman_id: userId, current_status: 'CLOSED' },
                ...options
            }),
            JobCancellation.count({
                where: {
                    cancelled_by_user_id: userId,
                    cancelled_by_role: 'HANDYMAN',
                    cancellation_action: 'HANDYMAN_WITHDRAW'
                },
                ...options
            })
        ]);
    } else {
        [completedCount, cancelledCount] = await Promise.all([
            Job.count({
                where: { customer_id: userId, current_status: 'CLOSED' },
                ...options
            }),
            JobCancellation.count({
                where: {
                    cancelled_by_user_id: userId,
                    cancelled_by_role: 'CUSTOMER',
                    cancellation_action: 'CANCEL_JOB'
                },
                ...options
            })
        ]);
    }

    const outcomeCount = completedCount + cancelledCount;
    const completionRate = outcomeCount > 0
        ? Number(((completedCount / outcomeCount) * 100).toFixed(2))
        : null;

    return {
        rating,
        review_count: reviewCount,
        completion_rate: completionRate
    };
};

const validateAcceptedJobInvariants = async (job, options = {}) => {
    if (!job.selected_bid_id
        || !job.selected_handyman_id
        || !job.deposit_transaction_id
        || !job.deposit_amount
        || !job.deposit_paid_at
        || !job.deposit_status) {
        return {
            error: serviceError(
                'Accepted job data is incomplete.',
                409,
                'ACCEPTED_DATA_INCONSISTENT'
            )
        };
    }

    if (job.deposit_status !== 'HELD') {
        return {
            error: serviceError(
                'The job deposit is not being held.',
                409,
                'DEPOSIT_NOT_HELD',
                { deposit_status: job.deposit_status }
            )
        };
    }

    const queryOptions = options.transaction
        ? { transaction: options.transaction }
        : {};

    const [selectedBid, customer, selectedHandyman, depositTransaction, systemEscrowWallet] = await Promise.all([
        Bid.findByPk(job.selected_bid_id, queryOptions),
        User.findByPk(job.customer_id, queryOptions),
        User.findByPk(job.selected_handyman_id, queryOptions),
        Transaction.findByPk(job.deposit_transaction_id, queryOptions),
        Wallet.findOne({
            where: { wallet_type: 'SYSTEM_ESCROW', user_id: null },
            ...queryOptions
        })
    ]);

    const depositAmount = toNumber(job.deposit_amount);
    const depositMatches = depositTransaction
        && depositTransaction.job_id === job.id
        && depositTransaction.transaction_type === 'DEPOSIT_10'
        && depositTransaction.status === 'SUCCESS'
        && systemEscrowWallet
        && depositTransaction.to_wallet_id === systemEscrowWallet.id
        && toNumber(depositTransaction.amount) === depositAmount;
    const bidMatches = selectedBid
        && selectedBid.job_id === job.id
        && selectedBid.handyman_id === job.selected_handyman_id
        && selectedBid.status === 'WON';

    if (!customer
        || customer.role !== 'CUSTOMER'
        || !selectedHandyman
        || selectedHandyman.role !== 'HANDYMAN'
        || !depositMatches
        || !bidMatches
        || depositAmount <= 0) {
        return {
            error: serviceError(
                'Accepted job relationships are inconsistent.',
                409,
                'ACCEPTED_DATA_INCONSISTENT'
            )
        };
    }

    return {
        selectedBid,
        customer,
        selectedHandyman,
        depositTransaction,
        systemEscrowWallet
    };
};

const getAcceptedDetailsService = async (jobId, currentUser) => {
    if (!isValidUuid(jobId)) {
        return serviceError('Invalid job id.', 400, 'VALIDATION_ERROR');
    }

    try {
        const job = await Job.findByPk(jobId, {
            include: [{ model: Service, attributes: ['id', 'name'] }]
        });

        if (!job) {
            return serviceError('Job not found.', 404, 'JOB_NOT_FOUND');
        }

        const isCustomer = currentUser.role === 'CUSTOMER' && job.customer_id === currentUser.id;
        const isSelectedHandyman = currentUser.role === 'HANDYMAN'
            && job.selected_handyman_id === currentUser.id;

        if (!isCustomer && !isSelectedHandyman) {
            return serviceError(
                'You do not have permission to view this accepted job.',
                403,
                'FORBIDDEN_JOB_ACCESS'
            );
        }

        if (job.current_status !== 'ACCEPTED') {
            return serviceError(
                'Job is not in ACCEPTED status.',
                409,
                'INVALID_JOB_STATUS',
                { current_status: job.current_status }
            );
        }

        const validation = await validateAcceptedJobInvariants(job);
        if (validation.error) return validation.error;

        const { selectedBid, customer, selectedHandyman } = validation;
        const partnerUser = isCustomer ? selectedHandyman : customer;
        const partnerRole = isCustomer ? 'HANDYMAN' : 'CUSTOMER';
        const partnerMetrics = await getPartnerMetrics(partnerUser.id, partnerRole);

        let partner = {
            role: partnerRole,
            id: partnerUser.id,
            full_name: partnerUser.full_name,
            avatar_url: partnerUser.avatar_url,
            phone_number: partnerUser.phone_number,
            ...partnerMetrics
        };

        if (partnerRole === 'HANDYMAN') {
            const profile = await HandymanProfile.findOne({
                where: { user_id: partnerUser.id },
                attributes: ['total_jobs_completed']
            });
            partner = {
                ...partner,
                total_jobs_completed: profile?.total_jobs_completed || 0,
                kyc_status: partnerUser.kyc_status
            };
        }

        const deposit = isCustomer
            ? {
                amount: toNumber(job.deposit_amount),
                percentage: 10,
                status: job.deposit_status,
                paid_at: job.deposit_paid_at,
                label: 'Tiền cọc đang được hệ thống tạm giữ'
            }
            : {
                amount: toNumber(job.deposit_amount),
                status: job.deposit_status,
                label: 'Khách hàng đã đặt cọc thành công'
            };

        return {
            EM: 'Accepted job details retrieved successfully.',
            EC: 0,
            DT: {
                job: {
                    id: job.id,
                    status: job.current_status,
                    service: job.Service
                        ? { id: job.Service.id, name: job.Service.name }
                        : null,
                    issue_description: job.issue_description,
                    images: job.images || [],
                    scheduled_at: job.scheduled_at,
                    service_address: job.service_address,
                    gps_lat: job.gps_lat == null ? null : Number(job.gps_lat),
                    gps_long: job.gps_long == null ? null : Number(job.gps_long),
                    accepted_at: job.accepted_at
                },
                selected_bid: {
                    id: selectedBid.id,
                    proposed_price: toNumber(selectedBid.proposed_price),
                    message: selectedBid.message,
                    status: selectedBid.status
                },
                deposit,
                partner,
                allowed_actions: isCustomer
                    ? ['REOPEN_BIDDING', 'CANCEL_JOB']
                    : ['START_MOVING', 'CANCEL_ACCEPTED_JOB']
            }
        };
    } catch (error) {
        console.error('>>> Error in getAcceptedDetailsService:', error);
        return serviceError('Unable to retrieve accepted job details.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const validateMovingPayload = (payload = {}) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return serviceError('Request body must be a JSON object.', 400, 'VALIDATION_ERROR');
    }

    const unknownFields = Object.keys(payload).filter(
        (field) => !['gps_lat', 'gps_long'].includes(field)
    );
    if (unknownFields.length > 0) {
        return serviceError(
            `Unsupported request fields: ${unknownFields.join(', ')}.`,
            400,
            'VALIDATION_ERROR'
        );
    }

    const hasLat = Object.prototype.hasOwnProperty.call(payload, 'gps_lat');
    const hasLong = Object.prototype.hasOwnProperty.call(payload, 'gps_long');

    if (hasLat !== hasLong) {
        return serviceError(
            'gps_lat and gps_long must be provided together.',
            400,
            'VALIDATION_ERROR'
        );
    }

    if (!hasLat) return { gps_lat: null, gps_long: null };

    const gpsLat = Number(payload.gps_lat);
    const gpsLong = Number(payload.gps_long);
    if (!Number.isFinite(gpsLat)
        || !Number.isFinite(gpsLong)
        || gpsLat < -90
        || gpsLat > 90
        || gpsLong < -180
        || gpsLong > 180) {
        return serviceError('Invalid GPS coordinates.', 400, 'VALIDATION_ERROR');
    }

    return { gps_lat: gpsLat, gps_long: gpsLong };
};

const startMovingService = async (jobId, handymanId, payload = {}) => {
    if (!isValidUuid(jobId)) {
        return serviceError('Invalid job id.', 400, 'VALIDATION_ERROR');
    }

    const coordinates = validateMovingPayload(payload);
    if (coordinates.EC) return coordinates;

    const transaction = await db.transaction();
    try {
        const job = await Job.findByPk(jobId, {
            transaction,
            lock: transaction.LOCK.UPDATE
        });

        if (!job) {
            await transaction.rollback();
            return serviceError('Job not found.', 404, 'JOB_NOT_FOUND');
        }

        if (job.current_status === 'EN_ROUTE' && job.selected_handyman_id === handymanId) {
            await transaction.rollback();
            return serviceError(
                'Handyman has already started moving for this job.',
                409,
                'JOB_ALREADY_EN_ROUTE'
            );
        }

        if (job.current_status !== 'ACCEPTED') {
            await transaction.rollback();
            return serviceError(
                'Job is not in ACCEPTED status.',
                409,
                'INVALID_JOB_STATUS',
                { current_status: job.current_status }
            );
        }

        if (job.selected_handyman_id !== handymanId) {
            await transaction.rollback();
            return serviceError(
                'Only the selected handyman can start moving for this job.',
                403,
                'FORBIDDEN_JOB_ACCESS'
            );
        }

        const validation = await validateAcceptedJobInvariants(job, { transaction });
        if (validation.error) {
            await transaction.rollback();
            return validation.error;
        }

        if (!validation.customer.is_active || !validation.selectedHandyman.is_active) {
            await transaction.rollback();
            return serviceError(
                'Customer and selected handyman must both be active.',
                409,
                'PARTICIPANT_INACTIVE'
            );
        }

        const enRouteAt = new Date();
        await job.update({
            current_status: 'EN_ROUTE',
            en_route_at: enRouteAt
        }, { transaction });

        await JobStatusHistory.create({
            job_id: job.id,
            changed_by_user_id: handymanId,
            old_status: 'ACCEPTED',
            new_status: 'EN_ROUTE',
            reason: 'HANDYMAN_STARTED_MOVING',
            trigger_gps_lat: coordinates.gps_lat,
            trigger_gps_long: coordinates.gps_long
        }, { transaction });

        await transaction.commit();
        return {
            EM: 'Handyman started moving.',
            EC: 0,
            DT: {
                job_id: job.id,
                status: 'EN_ROUTE',
                en_route_at: enRouteAt
            }
        };
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('>>> Error in startMovingService:', error);
        return serviceError('Unable to start moving.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

export {
    getAcceptedDetailsService,
    startMovingService,
    validateAcceptedJobInvariants,
    serviceError,
    isValidUuid
};
