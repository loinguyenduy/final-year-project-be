import { Op } from 'sequelize';
import db from '../../../core/database/connection.js';
import { refundHeldDeposit } from '../../fintech/services/DepositRefund.service.js';
import HandymanProfile from '../../identity/models/HandymanProfile.model.js';
import User from '../../identity/models/User.model.js';
import Bid from '../models/Bid.model.js';
import Job from '../models/Job.model.js';
import JobCancellation from '../models/JobCancellation.model.js';
import JobStatusHistory from '../models/JobStatusHistory.model.js';
import {
    isValidUuid,
    serviceError,
    validateAcceptedJobInvariants
} from './AcceptedJob.service.js';
import { CONVERSATION_CLOSED_REASONS } from '../../chat/constants/chat.constants.js';
import { bestEffortCloseConversationForJobCycle } from '../../chat/services/ConversationLifecycle.service.js';

const CUSTOMER_ACTIONS = ['REOPEN_BIDDING', 'CANCEL_JOB'];
const CUSTOMER_REASON_CODES = [
    'NO_LONGER_NEEDED',
    'SELECTED_WRONG_HANDYMAN',
    'HANDYMAN_NOT_SUITABLE',
    'SCHEDULE_CONFLICT',
    'CANNOT_CONTACT_HANDYMAN',
    'JOB_INFORMATION_CHANGED',
    'OTHER'
];
const HANDYMAN_REASON_CODES = [
    'SCHEDULE_CONFLICT',
    'OUTSIDE_EXPERTISE',
    'MISSING_REQUIRED_TOOLS',
    'CANNOT_REACH_LOCATION',
    'CANNOT_CONTACT_CUSTOMER',
    'PERSONAL_EMERGENCY',
    'JOB_INFORMATION_INACCURATE',
    'OTHER'
];

const validateReasonPayload = (payload, { requireAction = false, allowedReasonCodes }) => {
    const { action, reason_code, reason_text } = payload || {};

    if (requireAction && !CUSTOMER_ACTIONS.includes(action)) {
        return {
            error: serviceError(
                `action must be one of: ${CUSTOMER_ACTIONS.join(', ')}.`,
                400,
                'VALIDATION_ERROR'
            )
        };
    }

    if (!allowedReasonCodes.includes(reason_code)) {
        return {
            error: serviceError(
                `reason_code must be one of: ${allowedReasonCodes.join(', ')}.`,
                400,
                'VALIDATION_ERROR'
            )
        };
    }

    if (reason_text !== undefined && reason_text !== null && typeof reason_text !== 'string') {
        return {
            error: serviceError('reason_text must be a string.', 400, 'VALIDATION_ERROR')
        };
    }

    const normalizedReasonText = typeof reason_text === 'string' ? reason_text.trim() : null;
    if (reason_code === 'OTHER' && !normalizedReasonText) {
        return {
            error: serviceError(
                'reason_text is required when reason_code is OTHER.',
                400,
                'VALIDATION_ERROR'
            )
        };
    }

    if (normalizedReasonText && normalizedReasonText.length > 1000) {
        return {
            error: serviceError(
                'reason_text must not exceed 1000 characters.',
                400,
                'VALIDATION_ERROR'
            )
        };
    }

    return {
        action,
        reason_code,
        reason_text: normalizedReasonText
    };
};

const buildHistoryReason = ({ cancellation_action, reason_code, reason_text }) => {
    return [cancellation_action, reason_code, reason_text].filter(Boolean).join(': ');
};

const reopenEligibleLostBids = async (jobId, selectedBidId, transaction) => {
    const eligibleBids = await Bid.findAll({
        where: {
            job_id: jobId,
            id: { [Op.ne]: selectedBidId },
            status: 'LOST'
        },
        attributes: ['id'],
        include: [{
            model: User,
            attributes: [],
            where: { is_active: true },
            required: true
        }],
        transaction
    });

    const eligibleBidIds = eligibleBids.map((bid) => bid.id);
    if (eligibleBidIds.length > 0) {
        await Bid.update(
            { status: 'PENDING' },
            {
                where: { id: { [Op.in]: eligibleBidIds }, status: 'LOST' },
                transaction
            }
        );
    }

    return eligibleBidIds;
};

const ensureAcceptedAndHeld = (job) => {
    if (job.current_status !== 'ACCEPTED') {
        if (['EN_ROUTE', 'ARRIVED', 'QUOTE_PENDING'].includes(job.current_status)) {
            return serviceError(
                'Cancellation is not supported for the current job status.',
                409,
                'CANCELLATION_NOT_ALLOWED_IN_CURRENT_STATUS',
                { current_status: job.current_status }
            );
        }
        if (job.deposit_status === 'REFUNDED') {
            return serviceError(
                'This job deposit has already been refunded.',
                409,
                'DEPOSIT_ALREADY_REFUNDED'
            );
        }
        return serviceError(
            'Job is not in ACCEPTED status.',
            409,
            'INVALID_JOB_STATUS',
            { current_status: job.current_status }
        );
    }

    if (!job.deposit_status) {
        return serviceError(
            'Accepted job data is incomplete.',
            409,
            'ACCEPTED_DATA_INCONSISTENT'
        );
    }

    if (job.deposit_status !== 'HELD') {
        return serviceError(
            'The job deposit is not being held.',
            409,
            'DEPOSIT_NOT_HELD',
            { deposit_status: job.deposit_status }
        );
    }

    return null;
};

const cancelByCustomerService = async (jobId, customerId, payload) => {
    if (!isValidUuid(jobId)) {
        return serviceError('Invalid job id.', 400, 'VALIDATION_ERROR');
    }

    const validatedPayload = validateReasonPayload(payload, {
        requireAction: true,
        allowedReasonCodes: CUSTOMER_REASON_CODES
    });
    if (validatedPayload.error) return validatedPayload.error;

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

        if (job.customer_id !== customerId) {
            await transaction.rollback();
            return serviceError(
                'Only the job customer can cancel this accepted job.',
                403,
                'FORBIDDEN_JOB_ACCESS'
            );
        }

        const stateError = ensureAcceptedAndHeld(job);
        if (stateError) {
            await transaction.rollback();
            return stateError;
        }

        const validation = await validateAcceptedJobInvariants(job, { transaction });
        if (validation.error) {
            await transaction.rollback();
            return validation.error;
        }

        const acceptanceCycle = Number(job.acceptance_cycle || 0);
        const refundResult = await refundHeldDeposit(job, transaction);
        if (refundResult.error) {
            await transaction.rollback();
            return refundResult.error;
        }

        await validation.selectedBid.update(
            { status: 'CANCELLED_BY_CUSTOMER' },
            { transaction }
        );

        const isReopen = validatedPayload.action === 'REOPEN_BIDDING';
        if (isReopen) {
            await reopenEligibleLostBids(job.id, validation.selectedBid.id, transaction);
            await job.update({
                current_status: 'BIDDING',
                selected_handyman_id: null,
                selected_bid_id: null,
                deposit_status: 'REFUNDED'
            }, { transaction });
        } else {
            await job.update({
                current_status: 'CANCELLED',
                deposit_status: 'REFUNDED',
                cancelled_at: new Date()
            }, { transaction });
        }

        await JobCancellation.create({
            job_id: job.id,
            cancelled_by_user_id: customerId,
            cancelled_by_role: 'CUSTOMER',
            status_when_cancelled: 'ACCEPTED',
            cancellation_action: validatedPayload.action,
            reason_code: validatedPayload.reason_code,
            reason_text: validatedPayload.reason_text,
            refund_amount: refundResult.refunded_amount,
            penalty_amount: 0
        }, { transaction });

        const newStatus = isReopen ? 'BIDDING' : 'CANCELLED';
        await JobStatusHistory.create({
            job_id: job.id,
            changed_by_user_id: customerId,
            old_status: 'ACCEPTED',
            new_status: newStatus,
            reason: buildHistoryReason({
                cancellation_action: validatedPayload.action,
                reason_code: validatedPayload.reason_code,
                reason_text: validatedPayload.reason_text
            })
        }, { transaction });

        await transaction.commit();
        await bestEffortCloseConversationForJobCycle({
            jobId: job.id,
            acceptanceCycle,
            reason: isReopen
                ? CONVERSATION_CLOSED_REASONS.CUSTOMER_REOPEN_BIDDING
                : CONVERSATION_CLOSED_REASONS.CUSTOMER_CANCELLED_JOB,
            closedByUserId: customerId
        });
        return {
            EM: isReopen
                ? 'Job returned to bidding and deposit refunded.'
                : 'Job cancelled and deposit refunded.',
            EC: 0,
            DT: {
                job_id: job.id,
                status: newStatus,
                refunded_amount: refundResult.refunded_amount,
                deposit_status: 'REFUNDED'
            }
        };
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('>>> Error in cancelByCustomerService:', error);
        return serviceError('Unable to cancel accepted job.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const cancelByHandymanService = async (jobId, handymanId, payload) => {
    if (!isValidUuid(jobId)) {
        return serviceError('Invalid job id.', 400, 'VALIDATION_ERROR');
    }

    const validatedPayload = validateReasonPayload(payload, {
        allowedReasonCodes: HANDYMAN_REASON_CODES
    });
    if (validatedPayload.error) return validatedPayload.error;

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
                'Only the selected handyman can cancel this accepted job.',
                403,
                'FORBIDDEN_JOB_ACCESS'
            );
        }

        const stateError = ensureAcceptedAndHeld(job);
        if (stateError) {
            await transaction.rollback();
            return stateError;
        }

        const validation = await validateAcceptedJobInvariants(job, { transaction });
        if (validation.error) {
            await transaction.rollback();
            return validation.error;
        }

        const acceptanceCycle = Number(job.acceptance_cycle || 0);
        const handymanProfile = await HandymanProfile.findOne({
            where: { user_id: handymanId },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!handymanProfile) {
            await transaction.rollback();
            return serviceError(
                'Selected handyman profile is missing.',
                409,
                'ACCEPTED_DATA_INCONSISTENT'
            );
        }

        const refundResult = await refundHeldDeposit(job, transaction);
        if (refundResult.error) {
            await transaction.rollback();
            return refundResult.error;
        }

        await validation.selectedBid.update(
            { status: 'CANCELLED_BY_HANDYMAN' },
            { transaction }
        );
        await reopenEligibleLostBids(job.id, validation.selectedBid.id, transaction);
        await handymanProfile.increment('accepted_cancellation_count', {
            by: 1,
            transaction
        });
        await job.update({
            current_status: 'BIDDING',
            selected_handyman_id: null,
            selected_bid_id: null,
            deposit_status: 'REFUNDED'
        }, { transaction });

        await JobCancellation.create({
            job_id: job.id,
            cancelled_by_user_id: handymanId,
            cancelled_by_role: 'HANDYMAN',
            status_when_cancelled: 'ACCEPTED',
            cancellation_action: 'HANDYMAN_WITHDRAW',
            reason_code: validatedPayload.reason_code,
            reason_text: validatedPayload.reason_text,
            refund_amount: refundResult.refunded_amount,
            penalty_amount: 0
        }, { transaction });

        await JobStatusHistory.create({
            job_id: job.id,
            changed_by_user_id: handymanId,
            old_status: 'ACCEPTED',
            new_status: 'BIDDING',
            reason: buildHistoryReason({
                cancellation_action: 'HANDYMAN_WITHDRAW',
                reason_code: validatedPayload.reason_code,
                reason_text: validatedPayload.reason_text
            })
        }, { transaction });

        await transaction.commit();
        await bestEffortCloseConversationForJobCycle({
            jobId: job.id,
            acceptanceCycle,
            reason: CONVERSATION_CLOSED_REASONS.HANDYMAN_CANCELLED,
            closedByUserId: handymanId
        });
        return {
            EM: 'Accepted job cancelled by handyman and deposit refunded.',
            EC: 0,
            DT: {
                job_id: job.id,
                status: 'BIDDING',
                refunded_amount: refundResult.refunded_amount,
                deposit_status: 'REFUNDED'
            }
        };
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('>>> Error in cancelByHandymanService:', error);
        return serviceError('Unable to cancel accepted job.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

export { cancelByCustomerService, cancelByHandymanService };
