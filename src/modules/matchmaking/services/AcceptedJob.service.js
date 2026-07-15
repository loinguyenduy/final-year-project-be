import { fn, col } from 'sequelize';
import db from '../../../core/database/connection.js';
import Review from '../../dispute/models/Review.model.js';
import EvidenceVault from '../../fintech/models/EvidenceVault.model.js';
import Transaction from '../../fintech/models/Transaction.model.js';
import Wallet from '../../fintech/models/Wallet.model.js';
import HandymanProfile from '../../identity/models/HandymanProfile.model.js';
import User from '../../identity/models/User.model.js';
import Bid from '../models/Bid.model.js';
import Job from '../models/Job.model.js';
import JobCancellation from '../models/JobCancellation.model.js';
import JobArrivalRequest from '../models/JobArrivalRequest.model.js';
import JobStatusHistory from '../models/JobStatusHistory.model.js';
import JobQuote from '../models/JobQuote.model.js';
import JobQuoteItem from '../models/JobQuoteItem.model.js';
import Service from '../models/Service.model.js';
import { parseCoordinatePair } from '../utils/location.util.js';
import {
    buildArrivalRequestDto,
    buildDistanceSnapshot,
    buildEnRouteDto,
    calculateEstimatedArrivalMinutes,
    getCooldownRemainingSeconds,
    getJobLifecycleConfig,
    validateGpsEvidence
} from '../utils/jobLifecycle.util.js';
import {
    JOB_LIFECYCLE_EVENTS,
    emitJobLifecycleEvent
} from '../sockets/JobLifecycle.gateway.js';
import {
    buildSubmitReadiness,
    getQuoteConfig,
    normalizeStoredQuote,
    toCanonicalMoneyString
} from '../utils/quote.util.js';

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
    const acceptanceCycle = Number(job?.acceptance_cycle);
    if (!Number.isInteger(acceptanceCycle) || acceptanceCycle < 1) {
        return {
            error: serviceError(
                'Job acceptance cycle is inconsistent.',
                409,
                'ACCEPTANCE_CYCLE_INCONSISTENT'
            )
        };
    }

    if (typeof job?.service_address !== 'string' || !job.service_address.trim()) {
        return {
            error: serviceError(
                'Accepted job service address is missing.',
                409,
                'ACCEPTED_DATA_INCONSISTENT'
            )
        };
    }

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

const buildAllowedActions = ({
    job,
    isCustomer,
    isSelectedHandyman,
    isAdmin,
    pendingRequest,
    reviewRequired,
    retryAfterSeconds,
    currentQuote,
    beforeEvidenceCount,
    quoteReadiness,
    quoteConfig
}) => {
    if (isAdmin) return [];
    if (job.current_status === 'ACCEPTED') {
        if (isCustomer) return ['REOPEN_BIDDING', 'CANCEL_JOB'];
        if (isSelectedHandyman) return ['START_MOVING', 'CANCEL_ACCEPTED_JOB'];
        return [];
    }
    if (job.current_status === 'ARRIVED') {
        if (isCustomer) return ['WAIT_FOR_QUOTE'];
        if (!isSelectedHandyman) return [];

        const actions = [];
        const evidenceLocked = currentQuote && currentQuote.status !== 'DRAFT';
        if (!evidenceLocked) {
            if (beforeEvidenceCount < quoteConfig.beforeEvidenceMaxFiles) {
                actions.push('UPLOAD_BEFORE_EVIDENCE');
            }
            if (beforeEvidenceCount > 0) actions.push('DELETE_BEFORE_EVIDENCE');
        }
        if (!currentQuote) {
            actions.push('CREATE_QUOTE_DRAFT');
        } else if (currentQuote.status === 'DRAFT') {
            actions.push('UPDATE_QUOTE_DRAFT');
            if (quoteReadiness?.ready) actions.push('SUBMIT_QUOTE');
        }
        return actions;
    }
    if (job.current_status === 'QUOTE_PENDING') {
        if (isCustomer) return ['VIEW_QUOTE'];
        if (isSelectedHandyman) return ['WAIT_FOR_CUSTOMER_QUOTE_RESPONSE'];
        return [];
    }
    if (job.current_status !== 'EN_ROUTE') return [];

    if (pendingRequest) {
        return isCustomer
            ? ['CONFIRM_ARRIVAL', 'REJECT_ARRIVAL']
            : ['WAIT_ARRIVAL_CONFIRMATION'];
    }
    if (!isSelectedHandyman) return [];
    if (reviewRequired) return ['WAIT_ARRIVAL_REVIEW'];
    if (retryAfterSeconds > 0) return ['WAIT_ARRIVAL_COOLDOWN'];
    return ['REQUEST_ARRIVAL'];
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

        const isAdmin = currentUser.role === 'ADMIN';
        const isCustomer = currentUser.role === 'CUSTOMER' && job.customer_id === currentUser.id;
        const isSelectedHandyman = currentUser.role === 'HANDYMAN'
            && job.selected_handyman_id === currentUser.id;

        if (!isAdmin && !isCustomer && !isSelectedHandyman) {
            return serviceError(
                'You do not have permission to view this accepted job.',
                403,
                'FORBIDDEN_JOB_ACCESS'
            );
        }

        if (!['ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'QUOTE_PENDING'].includes(job.current_status)) {
            return serviceError(
                'Job is not in an accepted lifecycle status.',
                409,
                'INVALID_JOB_STATUS',
                { current_status: job.current_status }
            );
        }

        const validation = await validateAcceptedJobInvariants(job);
        if (validation.error) return validation.error;

        const { selectedBid, customer, selectedHandyman } = validation;
        let partner = null;
        if (!isAdmin) {
            const partnerUser = isCustomer ? selectedHandyman : customer;
            const partnerRole = isCustomer ? 'HANDYMAN' : 'CUSTOMER';
            const partnerMetrics = await getPartnerMetrics(partnerUser.id, partnerRole);

            partner = {
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
        }

        const lifecycleConfig = getJobLifecycleConfig();
        const quoteConfig = getQuoteConfig();
        const [
            latestArrivalRequest,
            rejectionCount,
            latestRejectedRequest,
            currentQuote,
            beforeEvidenceCount
        ] = await Promise.all([
            JobArrivalRequest.findOne({
                where: { job_id: job.id, acceptance_cycle: job.acceptance_cycle },
                order: [['requested_at', 'DESC'], ['createdAt', 'DESC']]
            }),
            JobArrivalRequest.count({
                where: {
                    job_id: job.id,
                    acceptance_cycle: job.acceptance_cycle,
                    status: 'REJECTED'
                }
            }),
            JobArrivalRequest.findOne({
                where: {
                    job_id: job.id,
                    acceptance_cycle: job.acceptance_cycle,
                    status: 'REJECTED'
                },
                order: [['responded_at', 'DESC'], ['updatedAt', 'DESC']]
            }),
            JobQuote.findOne({
                where: {
                    job_id: job.id,
                    acceptance_cycle: job.acceptance_cycle,
                    version: 1
                }
            }),
            EvidenceVault.count({
                where: {
                    job_id: job.id,
                    acceptance_cycle: job.acceptance_cycle,
                    customer_id: job.customer_id,
                    handyman_id: job.selected_handyman_id,
                    selected_bid_id: job.selected_bid_id,
                    uploader_id: job.selected_handyman_id,
                    stage: 'BEFORE',
                    media_type: 'IMAGE'
                }
            })
        ]);
        const quoteItems = currentQuote
            ? await JobQuoteItem.findAll({
                where: { quote_id: currentQuote.id },
                order: [['sort_order', 'ASC']]
            })
            : [];
        const normalizedQuote = currentQuote
            ? normalizeStoredQuote(currentQuote, quoteItems, selectedBid.proposed_price)
            : null;
        const quoteReadiness = !currentQuote
            ? null
            : normalizedQuote.valid
                ? buildSubmitReadiness({ normalized: normalizedQuote, evidenceCount: beforeEvidenceCount })
                : {
                    ready: false,
                    missing_requirements: ['INVALID_DRAFT_DATA'],
                    before_evidence_count: beforeEvidenceCount,
                    variance_reason_required: false
                };
        const pendingRequest = latestArrivalRequest?.status === 'PENDING'
            ? latestArrivalRequest
            : null;
        const reviewRequired = rejectionCount >= lifecycleConfig.maxRejectionsPerCycle;
        const retryAfterSeconds = job.current_status !== 'EN_ROUTE'
            || pendingRequest
            || reviewRequired
            ? 0
            : getCooldownRemainingSeconds(
                latestRejectedRequest?.responded_at,
                new Date(),
                lifecycleConfig.arrivalCooldownSeconds
            );
        const canSeeHandymanRawGps = isAdmin || isSelectedHandyman;
        const canSeeDraftQuote = isAdmin || isSelectedHandyman;
        const inspectionQuote = currentQuote
            && (currentQuote.status === 'SUBMITTED' || canSeeDraftQuote)
            ? {
                id: currentQuote.id,
                status: currentQuote.status,
                version: Number(currentQuote.version),
                ...(canSeeDraftQuote
                    ? { draft_revision: Number(currentQuote.draft_revision) }
                    : {}),
                total_amount: toCanonicalMoneyString(currentQuote.total_amount),
                currency: currentQuote.currency,
                submitted_at: currentQuote.submitted_at,
                before_evidence_count: beforeEvidenceCount,
                ...(canSeeDraftQuote ? { readiness: quoteReadiness } : {})
            }
            : null;

        const deposit = (isCustomer || isAdmin)
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
                    accepted_at: job.accepted_at,
                    acceptance_cycle: Number(job.acceptance_cycle),
                    arrived_at: job.arrived_at
                },
                selected_bid: {
                    id: selectedBid.id,
                    proposed_price: toNumber(selectedBid.proposed_price),
                    message: selectedBid.message,
                    status: selectedBid.status
                },
                deposit,
                partner,
                participants: isAdmin
                    ? {
                        customer: {
                            id: customer.id,
                            full_name: customer.full_name,
                            role: customer.role,
                            is_active: customer.is_active
                        },
                        handyman: {
                            id: selectedHandyman.id,
                            full_name: selectedHandyman.full_name,
                            role: selectedHandyman.role,
                            is_active: selectedHandyman.is_active
                        }
                    }
                    : undefined,
                en_route: buildEnRouteDto(job, { includeRawGps: canSeeHandymanRawGps }),
                arrival_request: buildArrivalRequestDto(latestArrivalRequest, {
                    includeRawGps: canSeeHandymanRawGps
                }),
                arrival_policy: {
                    rejection_count: rejectionCount,
                    max_rejections: lifecycleConfig.maxRejectionsPerCycle,
                    review_required: reviewRequired,
                    retry_after_seconds: retryAfterSeconds || null
                },
                inspection_quote: inspectionQuote,
                allowed_actions: buildAllowedActions({
                    job,
                    isCustomer,
                    isSelectedHandyman,
                    isAdmin,
                    pendingRequest,
                    reviewRequired,
                    retryAfterSeconds,
                    currentQuote,
                    beforeEvidenceCount,
                    quoteReadiness,
                    quoteConfig
                })
            }
        };
    } catch (error) {
        console.error('>>> Error in getAcceptedDetailsService:', error?.message || 'Unknown error');
        return serviceError('Unable to retrieve accepted job details.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const validateMovingPayload = (payload = {}) => {
    const validation = validateGpsEvidence(payload);
    if (!validation.valid) {
        return serviceError(validation.error, 400, 'INVALID_COORDINATES');
    }
    return validation;
};

const startMovingService = async (jobId, handymanId, payload = {}) => {
    if (!isValidUuid(jobId)) {
        return serviceError('Invalid job id.', 400, 'VALIDATION_ERROR');
    }

    const handymanCoordinates = validateMovingPayload(payload);
    if (handymanCoordinates.EC) return handymanCoordinates;

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

        if (job.selected_handyman_id !== handymanId) {
            await transaction.rollback();
            return serviceError(
                'Only the selected handyman can start moving for this job.',
                403,
                'FORBIDDEN_JOB_ACCESS'
            );
        }

        const acceptanceCycle = Number(job.acceptance_cycle);
        if (!Number.isInteger(acceptanceCycle) || acceptanceCycle < 1) {
            await transaction.rollback();
            return serviceError(
                'Job acceptance cycle is inconsistent.',
                409,
                'ACCEPTANCE_CYCLE_INCONSISTENT'
            );
        }

        if (job.current_status === 'EN_ROUTE') {
            await transaction.rollback();
            return {
                EM: 'Handyman has already started moving for this job.',
                EC: 0,
                code: 'EN_ROUTE_ALREADY_STARTED',
                DT: {
                    job_id: job.id,
                    acceptance_cycle: Number(job.acceptance_cycle),
                    status: job.current_status,
                    en_route: buildEnRouteDto(job, { includeRawGps: true })
                }
            };
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

        const jobCoordinates = parseCoordinatePair(job.gps_lat, job.gps_long);
        if (!jobCoordinates.valid) {
            await transaction.rollback();
            return serviceError(
                'Job location data is inconsistent.',
                409,
                'ACCEPTED_DATA_INCONSISTENT'
            );
        }
        if (jobCoordinates.hasCoordinates && !handymanCoordinates.hasCoordinates) {
            await transaction.rollback();
            return serviceError(
                'Handyman GPS is required because this job has coordinates.',
                400,
                'HANDYMAN_LOCATION_REQUIRED'
            );
        }

        const lifecycleConfig = getJobLifecycleConfig();
        const distance = buildDistanceSnapshot({
            handymanCoordinates,
            jobCoordinates
        });
        const estimatedArrivalMinutes = calculateEstimatedArrivalMinutes(
            distance.distanceMeters,
            lifecycleConfig
        );
        const enRouteAt = new Date();
        await job.update({
            current_status: 'EN_ROUTE',
            en_route_at: enRouteAt,
            en_route_gps_lat: handymanCoordinates.latitude,
            en_route_gps_long: handymanCoordinates.longitude,
            en_route_gps_accuracy_meters: handymanCoordinates.accuracyMeters,
            en_route_distance_meters: distance.distanceMeters,
            en_route_estimated_arrival_minutes: estimatedArrivalMinutes
        }, { transaction });

        await JobStatusHistory.create({
            job_id: job.id,
            changed_by_user_id: handymanId,
            old_status: 'ACCEPTED',
            new_status: 'EN_ROUTE',
            reason: 'HANDYMAN_STARTED_MOVING',
            trigger_gps_lat: handymanCoordinates.latitude,
            trigger_gps_long: handymanCoordinates.longitude
        }, { transaction });

        await transaction.commit();
        const eventPayload = {
            job_id: job.id,
            acceptance_cycle: Number(job.acceptance_cycle),
            status: 'EN_ROUTE',
            started_at: enRouteAt,
            distance_meters: distance.distanceMeters,
            distance_km: distance.distanceKm,
            estimated_arrival_minutes: estimatedArrivalMinutes
        };
        emitJobLifecycleEvent({
            event: JOB_LIFECYCLE_EVENTS.EN_ROUTE,
            userIds: [job.customer_id],
            payload: eventPayload
        });
        return {
            EM: 'Handyman started moving.',
            EC: 0,
            code: 'EN_ROUTE_STARTED',
            DT: {
                job_id: job.id,
                acceptance_cycle: Number(job.acceptance_cycle),
                status: 'EN_ROUTE',
                en_route: buildEnRouteDto(job, { includeRawGps: true })
            }
        };
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('>>> Error in startMovingService:', error?.message || 'Unknown error');
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
