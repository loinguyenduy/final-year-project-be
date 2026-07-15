import { Op } from 'sequelize';
import db from '../../../core/database/connection.js';
import { CONVERSATION_CLOSED_REASONS } from '../../chat/constants/chat.constants.js';
import Conversation from '../../chat/models/Conversation.model.js';
import { closeConversationRecord } from '../../chat/services/ConversationLifecycle.service.js';
import Transaction from '../../fintech/models/Transaction.model.js';
import Wallet from '../../fintech/models/Wallet.model.js';
import User from '../../identity/models/User.model.js';
import Bid from '../models/Bid.model.js';
import Job from '../models/Job.model.js';
import JobArrivalRequest from '../models/JobArrivalRequest.model.js';
import JobCancellation from '../models/JobCancellation.model.js';
import JobQuote from '../models/JobQuote.model.js';
import JobStatusHistory from '../models/JobStatusHistory.model.js';
import {
    JOB_LIFECYCLE_EVENTS,
    emitJobLifecycleEvent
} from '../sockets/JobLifecycle.gateway.js';
import {
    ACTIVE_CANCELLATION_STATUSES,
    CANCELLABLE_JOB_STATUSES,
    buildCancellationDto,
    calculateCancellationDistribution,
    parseDecimalHundredths,
    parseVndInteger,
    validateCancellationPayload,
    validateCounterpartyResponsePayload
} from '../utils/cancellationPolicy.util.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isValidUuid = (value) => UUID_PATTERN.test(String(value || ''));
const serviceError = (EM, EC, code, DT = '') => ({ EM, EC, code, DT });

const rollbackWith = async (transaction, result) => {
    if (!transaction.finished) await transaction.rollback();
    return result;
};

const getParticipantRole = (job, currentUser) => {
    if (currentUser?.role === 'CUSTOMER' && job.customer_id === currentUser.id) {
        return 'CUSTOMER';
    }
    if (currentUser?.role === 'HANDYMAN' && job.selected_handyman_id === currentUser.id) {
        return 'HANDYMAN';
    }
    return null;
};

const validateLateLifecycleInvariants = async (job, transaction) => {
    const acceptanceCycle = Number(job.acceptance_cycle);
    if (!Number.isInteger(acceptanceCycle) || acceptanceCycle < 1) {
        return {
            error: serviceError(
                'Job acceptance cycle is inconsistent.',
                409,
                'ACCEPTANCE_CYCLE_INCONSISTENT'
            )
        };
    }
    if (!job.selected_bid_id
        || !job.selected_handyman_id
        || !job.deposit_transaction_id
        || job.deposit_amount == null
        || !job.deposit_paid_at
        || job.deposit_status !== 'HELD') {
        return {
            error: serviceError(
                'Accepted job data is incomplete or the deposit is not held.',
                409,
                'ACCEPTED_DATA_INCONSISTENT'
            )
        };
    }

    const deposit = parseVndInteger(job.deposit_amount);
    if (!deposit.valid || deposit.amount <= 0n) {
        return {
            error: serviceError(
                'Job deposit must be a positive VND integer.',
                409,
                'ACCEPTED_DATA_INCONSISTENT'
            )
        };
    }

    const [selectedBid, customer, handyman, originalDeposit, systemEscrow] = await Promise.all([
        Bid.findByPk(job.selected_bid_id, { transaction }),
        User.findByPk(job.customer_id, { transaction }),
        User.findByPk(job.selected_handyman_id, { transaction }),
        Transaction.findByPk(job.deposit_transaction_id, { transaction }),
        Wallet.findOne({
            where: { wallet_type: 'SYSTEM_ESCROW', user_id: null },
            transaction
        })
    ]);

    const originalAmount = parseVndInteger(originalDeposit?.amount);
    const depositMatches = originalDeposit
        && originalDeposit.job_id === job.id
        && originalDeposit.transaction_type === 'DEPOSIT_10'
        && originalDeposit.status === 'SUCCESS'
        && systemEscrow
        && originalDeposit.to_wallet_id === systemEscrow.id
        && originalAmount.valid
        && originalAmount.amount === deposit.amount;
    const bidMatches = selectedBid
        && selectedBid.job_id === job.id
        && selectedBid.handyman_id === job.selected_handyman_id
        && selectedBid.status === 'WON';
    const participantsMatch = customer
        && customer.role === 'CUSTOMER'
        && customer.is_active
        && handyman
        && handyman.role === 'HANDYMAN'
        && handyman.is_active;

    if (!depositMatches || !bidMatches || !participantsMatch) {
        return {
            error: serviceError(
                'Accepted job relationships are inconsistent or inactive.',
                409,
                'ACCEPTED_DATA_INCONSISTENT'
            )
        };
    }

    return {
        acceptanceCycle,
        depositAmount: deposit.amount,
        selectedBid,
        customer,
        handyman
    };
};

const findCurrentCancellation = (job, transaction = null, lock = false) => {
    const options = {
        where: {
            job_id: job.id,
            acceptance_cycle: job.acceptance_cycle,
            status: { [Op.in]: [...ACTIVE_CANCELLATION_STATUSES, 'RESOLVED'] }
        },
        order: [['createdAt', 'DESC']]
    };
    if (transaction) options.transaction = transaction;
    if (transaction && lock) options.lock = transaction.LOCK.UPDATE;
    return JobCancellation.findOne(options);
};

const isSameCancellationRetry = (cancellation, currentUser, payload) => {
    const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : null;
    return cancellation?.cancelled_by_user_id === currentUser?.id
        && cancellation?.cancelled_by_role === currentUser?.role
        && cancellation?.reason_code === reason;
};

const existingCancellationResult = (cancellation) => ({
    EM: 'Cancellation already exists for this job acceptance cycle.',
    EC: 0,
    code: 'CANCELLATION_ALREADY_EXISTS',
    DT: buildCancellationDto(cancellation)
});

const emitCancellationEvent = ({ event, job, cancellation }) => {
    const dto = buildCancellationDto(cancellation);
    emitJobLifecycleEvent({
        event,
        userIds: [job.customer_id, job.selected_handyman_id],
        payload: {
            job_id: job.id,
            cancellation_id: cancellation.id,
            acceptance_cycle: Number(cancellation.acceptance_cycle),
            status: cancellation.status,
            cancelled_from_status: cancellation.status_when_cancelled,
            reason: cancellation.reason_code,
            customer_refund_amount: dto.financial_preview.customer_refund_amount,
            handyman_compensation_amount:
                dto.financial_preview.handyman_compensation_amount,
            resolved_at: cancellation.resolved_at
        }
    });
};

const lockWallet = (where, transaction) => Wallet.findOne({
    where,
    transaction,
    lock: transaction.LOCK.UPDATE
});

const createPayoutTransaction = async ({
    cancellation,
    job,
    originalDeposit,
    transactionType,
    amount,
    fromWallet,
    toWallet,
    transferKey,
    transaction
}) => {
    if (amount === 0n) return null;
    const idempotencyKey = `cancellation:${cancellation.id}:${transferKey}`;
    const existing = await Transaction.findOne({
        where: { idempotency_key: idempotencyKey },
        transaction,
        lock: transaction.LOCK.UPDATE
    });
    if (existing) return existing;

    return Transaction.create({
        amount: amount.toString(),
        transaction_type: transactionType,
        status: 'SUCCESS',
        payment_method: 'INTERNAL',
        payment_gateway_code: null,
        description: `${transferKey} for cancelled job ${job.id}`,
        from_wallet_id: fromWallet.id,
        to_wallet_id: toWallet.id,
        job_id: job.id,
        reference_transaction_id: originalDeposit.id,
        cancellation_id: cancellation.id,
        idempotency_key: idempotencyKey,
        expires_at: null
    }, { transaction });
};

const supersedePendingArrival = (job, cancellation, transaction) => {
    if (cancellation.status_when_cancelled !== 'EN_ROUTE') return Promise.resolve([0]);
    return JobArrivalRequest.update(
        { status: 'SUPERSEDED' },
        {
            where: {
                job_id: job.id,
                acceptance_cycle: cancellation.acceptance_cycle,
                status: 'PENDING'
            },
            transaction
        }
    );
};

const supersedeDraftQuote = (job, cancellation, transaction) => JobQuote.update(
    { status: 'SUPERSEDED' },
    {
        where: {
            job_id: job.id,
            acceptance_cycle: cancellation.acceptance_cycle,
            status: 'DRAFT'
        },
        transaction
    }
);

const resolveCancellationInTransaction = async ({
    job,
    cancellation,
    invariant,
    distribution,
    resolvedByUserId,
    resolutionNote,
    transaction
}) => {
    const customerWallet = await lockWallet({
        user_id: job.customer_id,
        wallet_type: 'CUSTOMER_MAIN'
    }, transaction);
    if (!customerWallet) {
        return { error: serviceError('Customer main wallet not found.', 404, 'CUSTOMER_WALLET_NOT_FOUND') };
    }

    const handymanWallet = await lockWallet({
        user_id: job.selected_handyman_id,
        wallet_type: 'HANDYMAN_MAIN'
    }, transaction);
    if (!handymanWallet) {
        return { error: serviceError('Handyman main wallet not found.', 404, 'HANDYMAN_WALLET_NOT_FOUND') };
    }

    const systemEscrow = await lockWallet({
        wallet_type: 'SYSTEM_ESCROW',
        user_id: null
    }, transaction);
    if (!systemEscrow) {
        return { error: serviceError('SYSTEM_ESCROW wallet not found.', 404, 'SYSTEM_ESCROW_WALLET_NOT_FOUND') };
    }
    if (customerWallet.is_blocked || handymanWallet.is_blocked || systemEscrow.is_blocked) {
        return {
            error: serviceError(
                'A wallet required for cancellation distribution is blocked.',
                409,
                'CANCELLATION_WALLET_BLOCKED'
            )
        };
    }

    const originalDeposit = await Transaction.findOne({
        where: {
            id: job.deposit_transaction_id,
            job_id: job.id,
            transaction_type: 'DEPOSIT_10',
            status: 'SUCCESS'
        },
        transaction,
        lock: transaction.LOCK.UPDATE
    });
    const originalAmount = parseVndInteger(originalDeposit?.amount);
    if (!originalDeposit
        || originalDeposit.to_wallet_id !== systemEscrow.id
        || !originalAmount.valid
        || originalAmount.amount !== invariant.depositAmount) {
        return {
            error: serviceError(
                'Original deposit transaction is missing or inconsistent.',
                409,
                'ACCEPTED_DATA_INCONSISTENT'
            )
        };
    }

    const priorRelease = await Transaction.findOne({
        where: {
            reference_transaction_id: originalDeposit.id,
            status: 'SUCCESS',
            [Op.or]: [
                { transaction_type: 'DEPOSIT_REFUND' },
                {
                    transaction_type: {
                        [Op.in]: ['CANCELLATION_REFUND', 'CANCELLATION_COMPENSATION']
                    },
                    cancellation_id: { [Op.ne]: cancellation.id }
                }
            ]
        },
        transaction,
        lock: transaction.LOCK.UPDATE
    });
    if (priorRelease) {
        return {
            error: serviceError(
                'This deposit has already been released.',
                409,
                'DEPOSIT_ALREADY_RELEASED'
            )
        };
    }

    const existingCurrentRelease = await Transaction.findOne({
        where: {
            cancellation_id: cancellation.id,
            status: 'SUCCESS',
            transaction_type: {
                [Op.in]: ['CANCELLATION_REFUND', 'CANCELLATION_COMPENSATION']
            }
        },
        transaction,
        lock: transaction.LOCK.UPDATE
    });
    if (existingCurrentRelease) {
        return {
            error: serviceError(
                'Cancellation payout state is inconsistent.',
                409,
                'CANCELLATION_PAYOUT_INCONSISTENT'
            )
        };
    }

    const escrowBalance = parseDecimalHundredths(systemEscrow.balance);
    const requiredHundredths = distribution.depositAmount * 100n;
    if (!escrowBalance.valid || escrowBalance.amount < requiredHundredths) {
        return {
            error: serviceError(
                'SYSTEM_ESCROW does not have enough balance for this cancellation.',
                409,
                'ESCROW_INSUFFICIENT_BALANCE',
                { required_amount: distribution.depositAmount.toString() }
            )
        };
    }

    await systemEscrow.decrement('balance', {
        by: distribution.depositAmount.toString(),
        transaction
    });
    if (distribution.customerAmount > 0n) {
        await customerWallet.increment('balance', {
            by: distribution.customerAmount.toString(),
            transaction
        });
    }
    if (distribution.handymanAmount > 0n) {
        await handymanWallet.increment('balance', {
            by: distribution.handymanAmount.toString(),
            transaction
        });
    }

    const customerTransaction = await createPayoutTransaction({
        cancellation,
        job,
        originalDeposit,
        transactionType: 'CANCELLATION_REFUND',
        amount: distribution.customerAmount,
        fromWallet: systemEscrow,
        toWallet: customerWallet,
        transferKey: 'CUSTOMER_REFUND',
        transaction
    });
    const handymanTransaction = await createPayoutTransaction({
        cancellation,
        job,
        originalDeposit,
        transactionType: 'CANCELLATION_COMPENSATION',
        amount: distribution.handymanAmount,
        fromWallet: systemEscrow,
        toWallet: handymanWallet,
        transferKey: 'HANDYMAN_COMPENSATION',
        transaction
    });

    const bidStatus = cancellation.cancelled_by_role === 'CUSTOMER'
        ? 'CANCELLED_BY_CUSTOMER'
        : 'CANCELLED_BY_HANDYMAN';
    await invariant.selectedBid.update({ status: bidStatus }, { transaction });
    await supersedePendingArrival(job, cancellation, transaction);
    await supersedeDraftQuote(job, cancellation, transaction);

    const oldStatus = job.current_status;
    const resolvedAt = new Date();
    const depositStatus = distribution.handymanAmount === 0n
        && distribution.platformAmount === 0n
        ? 'REFUNDED'
        : 'DISTRIBUTED';
    await job.update({
        current_status: 'CANCELLED',
        deposit_status: depositStatus,
        cancelled_at: resolvedAt
    }, { transaction });

    await JobStatusHistory.create({
        job_id: job.id,
        changed_by_user_id: resolvedByUserId,
        old_status: oldStatus,
        new_status: 'CANCELLED',
        reason: `LIFECYCLE_CANCELLATION_RESOLVED:${cancellation.id}`
    }, { transaction });

    const conversation = await Conversation.findOne({
        where: {
            job_id: job.id,
            acceptance_cycle: cancellation.acceptance_cycle
        },
        transaction,
        lock: transaction.LOCK.UPDATE
    });
    if (conversation) {
        await closeConversationRecord(conversation, {
            reason: CONVERSATION_CLOSED_REASONS.JOB_CANCELLED,
            closedByUserId: resolvedByUserId,
            transaction
        });
    }

    await cancellation.update({
        status: 'RESOLVED',
        deposit_amount: distribution.depositAmount.toString(),
        refund_amount: distribution.customerAmount.toString(),
        handyman_compensation_amount: distribution.handymanAmount.toString(),
        platform_amount: distribution.platformAmount.toString(),
        customer_refund_transaction_id: customerTransaction?.id || null,
        handyman_compensation_transaction_id: handymanTransaction?.id || null,
        platform_transaction_id: null,
        resolved_at: resolvedAt,
        resolved_by_user_id: resolvedByUserId,
        resolution_note: resolutionNote
    }, { transaction });

    return { depositStatus };
};

const applyLifecycleCancellationInTransaction = async ({
    job,
    currentUser,
    payload,
    transaction
}) => {
    const participantRole = getParticipantRole(job, currentUser);
    if (!participantRole) {
        return {
            error: serviceError(
                'Only current job participants can request cancellation.',
                403,
                'FORBIDDEN_JOB_ACCESS'
            )
        };
    }

    const acceptanceCycle = Number(job.acceptance_cycle);
    if (!Number.isInteger(acceptanceCycle) || acceptanceCycle < 1) {
        return {
            error: serviceError(
                'Job acceptance cycle is inconsistent.',
                409,
                'ACCEPTANCE_CYCLE_INCONSISTENT'
            )
        };
    }

    const existing = await findCurrentCancellation(job, transaction, true);
    if (existing) {
        if (isSameCancellationRetry(existing, currentUser, payload)) {
            return {
                result: existingCancellationResult(existing),
                cancellation: existing,
                event: null,
                created: false
            };
        }
        return {
            error: serviceError(
                existing.status === 'RESOLVED'
                    ? 'This job cancellation has already been resolved.'
                    : 'A cancellation is already active for this job acceptance cycle.',
                409,
                existing.status === 'RESOLVED'
                    ? 'CANCELLATION_ALREADY_RESOLVED'
                    : 'CANCELLATION_ALREADY_ACTIVE',
                { cancellation_id: existing.id, status: existing.status }
            )
        };
    }

    if (!CANCELLABLE_JOB_STATUSES.includes(job.current_status)) {
        return {
            error: serviceError(
                'Cancellation is not supported for the current job status.',
                409,
                'CANCELLATION_NOT_ALLOWED_IN_CURRENT_STATUS',
                { current_status: job.current_status }
            )
        };
    }

    const validatedPayload = validateCancellationPayload(
        payload,
        participantRole,
        job.current_status
    );
    if (!validatedPayload.valid) {
        return {
            error: serviceError(validatedPayload.message, 400, 'VALIDATION_ERROR')
        };
    }

    const invariant = await validateLateLifecycleInvariants(job, transaction);
    if (invariant.error) return { error: invariant.error };

    const requiresReview = validatedPayload.resolutionMode === 'ADMIN_REVIEW';
    const awaitsCounterparty = validatedPayload.resolutionMode
        === 'COUNTERPARTY_ACKNOWLEDGEMENT';
    const distribution = requiresReview
        ? null
        : calculateCancellationDistribution({
            depositAmount: invariant.depositAmount,
            phase: job.current_status,
            classification: validatedPayload.classification
        });
    if (distribution && !distribution.valid) {
        return {
            error: serviceError(
                distribution.message,
                409,
                'CANCELLATION_POLICY_NOT_CONFIGURED'
            )
        };
    }

    const requestedAt = new Date();
    const cancellation = await JobCancellation.create({
        job_id: job.id,
        acceptance_cycle: invariant.acceptanceCycle,
        cancelled_by_user_id: currentUser.id,
        cancelled_by_role: participantRole,
        status_when_cancelled: job.current_status,
        cancellation_action: 'LIFECYCLE_CANCEL',
        reason_code: validatedPayload.reason,
        reason_text: validatedPayload.reasonText,
        classification: validatedPayload.classification,
        resolution_mode: validatedPayload.resolutionMode,
        status: requiresReview
            ? 'REVIEW_REQUIRED'
            : awaitsCounterparty
                ? 'AWAITING_COUNTERPARTY'
                : 'RESOLVED',
        deposit_amount: invariant.depositAmount.toString(),
        refund_amount: distribution?.customerAmount?.toString() ?? null,
        handyman_compensation_amount: distribution?.handymanAmount?.toString() ?? null,
        platform_amount: distribution?.platformAmount?.toString() ?? null,
        penalty_amount: 0,
        requested_at: requestedAt
    }, { transaction });

    let code;
    let message;
    let event;
    if (!requiresReview && !awaitsCounterparty) {
        const resolved = await resolveCancellationInTransaction({
            job,
            cancellation,
            invariant,
            distribution,
            resolvedByUserId: currentUser.id,
            resolutionNote: 'AUTO_POLICY',
            transaction
        });
        if (resolved.error) return { error: resolved.error };
        code = 'CANCELLATION_RESOLVED';
        message = 'Job cancellation was resolved successfully.';
        event = JOB_LIFECYCLE_EVENTS.CANCELLED;
    } else {
        await job.update({ current_status: 'CANCELLATION_REVIEW' }, { transaction });
        await supersedePendingArrival(job, cancellation, transaction);
        await JobStatusHistory.create({
            job_id: job.id,
            changed_by_user_id: currentUser.id,
            old_status: cancellation.status_when_cancelled,
            new_status: 'CANCELLATION_REVIEW',
            reason: `LIFECYCLE_CANCELLATION_REQUESTED:${cancellation.id}`
        }, { transaction });

        if (requiresReview) {
            code = 'CANCELLATION_REVIEW_REQUIRED';
            message = 'Cancellation requires review. The deposit remains held.';
            event = JOB_LIFECYCLE_EVENTS.CANCELLATION_REVIEW_REQUIRED;
        } else {
            code = 'CANCELLATION_AWAITING_COUNTERPARTY';
            message = 'Cancellation is awaiting counterparty confirmation.';
            event = JOB_LIFECYCLE_EVENTS.CANCELLATION_REQUESTED;
        }
    }

    return {
        result: {
            EM: message,
            EC: 0,
            code,
            DT: buildCancellationDto(cancellation)
        },
        cancellation,
        event,
        created: true
    };
};

const createCancellationService = async (jobId, currentUser, payload) => {
    if (!isValidUuid(jobId)) {
        return serviceError('Invalid job id.', 400, 'VALIDATION_ERROR');
    }

    const transaction = await db.transaction();
    try {
        const job = await Job.findByPk(jobId, {
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!job) {
            return rollbackWith(transaction, serviceError('Job not found.', 404, 'JOB_NOT_FOUND'));
        }

        const outcome = await applyLifecycleCancellationInTransaction({
            job,
            currentUser,
            payload,
            transaction
        });
        if (outcome.error) return rollbackWith(transaction, outcome.error);

        await transaction.commit();
        if (outcome.event) {
            emitCancellationEvent({
                event: outcome.event,
                job,
                cancellation: outcome.cancellation
            });
        }
        return outcome.result;
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('[matchmaking] Failed to create lifecycle cancellation.', {
            job_id: jobId,
            user_id: currentUser?.id,
            error: error?.message || 'Unknown error'
        });
        return serviceError('Unable to create cancellation.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const getCurrentCancellationService = async (jobId, currentUser) => {
    if (!isValidUuid(jobId)) {
        return serviceError('Invalid job id.', 400, 'VALIDATION_ERROR');
    }
    try {
        const job = await Job.findByPk(jobId);
        if (!job) return serviceError('Job not found.', 404, 'JOB_NOT_FOUND');

        const canRead = currentUser?.role === 'ADMIN'
            || (currentUser?.role === 'CUSTOMER' && job.customer_id === currentUser.id)
            || (currentUser?.role === 'HANDYMAN' && job.selected_handyman_id === currentUser.id);
        if (!canRead) {
            return serviceError('Cancellation not found.', 404, 'CANCELLATION_NOT_FOUND');
        }

        const cancellation = await findCurrentCancellation(job);
        if (!cancellation) {
            return serviceError('Cancellation not found.', 404, 'CANCELLATION_NOT_FOUND');
        }
        return {
            EM: 'Current cancellation retrieved successfully.',
            EC: 0,
            code: 'CURRENT_CANCELLATION_RETRIEVED',
            DT: buildCancellationDto(cancellation)
        };
    } catch (error) {
        console.error('[matchmaking] Failed to get lifecycle cancellation.', {
            job_id: jobId,
            error: error?.message || 'Unknown error'
        });
        return serviceError('Unable to retrieve cancellation.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const loadCounterpartyResponseContext = async ({
    jobId,
    cancellationId,
    currentUser,
    transaction
}) => {
    const job = await Job.findByPk(jobId, {
        transaction,
        lock: transaction.LOCK.UPDATE
    });
    if (!job) return { error: serviceError('Job not found.', 404, 'JOB_NOT_FOUND') };

    const participantRole = getParticipantRole(job, currentUser);
    if (!participantRole) {
        return {
            error: serviceError('Cancellation not found.', 404, 'CANCELLATION_NOT_FOUND')
        };
    }

    const cancellation = await JobCancellation.findOne({
        where: {
            id: cancellationId,
            job_id: job.id,
            acceptance_cycle: job.acceptance_cycle
        },
        transaction,
        lock: transaction.LOCK.UPDATE
    });
    if (!cancellation) {
        return { error: serviceError('Cancellation not found.', 404, 'CANCELLATION_NOT_FOUND') };
    }
    if (cancellation.cancelled_by_user_id === currentUser.id
        || cancellation.cancelled_by_role === participantRole) {
        return {
            error: serviceError(
                'Only the cancellation counterparty can respond.',
                403,
                'CANCELLATION_COUNTERPARTY_REQUIRED'
            )
        };
    }
    return { job, cancellation };
};

const confirmCancellationService = async (jobId, cancellationId, currentUser, payload = {}) => {
    if (!isValidUuid(jobId) || !isValidUuid(cancellationId)) {
        return serviceError('Invalid job or cancellation id.', 400, 'VALIDATION_ERROR');
    }
    if (!payload
        || typeof payload !== 'object'
        || Array.isArray(payload)
        || Object.keys(payload).length > 0) {
        return serviceError('Confirmation body must be empty.', 400, 'VALIDATION_ERROR');
    }

    const transaction = await db.transaction();
    try {
        const context = await loadCounterpartyResponseContext({
            jobId,
            cancellationId,
            currentUser,
            transaction
        });
        if (context.error) return rollbackWith(transaction, context.error);
        const { job, cancellation } = context;

        if (cancellation.status === 'RESOLVED'
            && cancellation.counterparty_response === 'CONFIRMED') {
            await transaction.commit();
            return {
                EM: 'Cancellation was already confirmed and resolved.',
                EC: 0,
                code: 'CANCELLATION_ALREADY_CONFIRMED',
                DT: buildCancellationDto(cancellation)
            };
        }
        if (cancellation.counterparty_response === 'REJECTED'
            || cancellation.status === 'REVIEW_REQUIRED') {
            return rollbackWith(
                transaction,
                serviceError(
                    'Cancellation response has already been finalized.',
                    409,
                    'CANCELLATION_RESPONSE_CONFLICT'
                )
            );
        }
        if (job.current_status !== 'CANCELLATION_REVIEW'
            || cancellation.status !== 'AWAITING_COUNTERPARTY'
            || cancellation.reason_code !== 'MUTUAL_AGREEMENT'
            || cancellation.resolution_mode !== 'COUNTERPARTY_ACKNOWLEDGEMENT') {
            return rollbackWith(
                transaction,
                serviceError(
                    'Cancellation is not awaiting counterparty confirmation.',
                    409,
                    'INVALID_CANCELLATION_STATUS'
                )
            );
        }

        const invariant = await validateLateLifecycleInvariants(job, transaction);
        if (invariant.error) return rollbackWith(transaction, invariant.error);
        const storedDeposit = parseVndInteger(cancellation.deposit_amount);
        if (!storedDeposit.valid || storedDeposit.amount !== invariant.depositAmount) {
            return rollbackWith(
                transaction,
                serviceError('Cancellation deposit is inconsistent.', 409, 'ACCEPTED_DATA_INCONSISTENT')
            );
        }
        const distribution = calculateCancellationDistribution({
            depositAmount: invariant.depositAmount,
            phase: cancellation.status_when_cancelled,
            classification: 'NEUTRAL'
        });
        if (!distribution.valid) {
            return rollbackWith(
                transaction,
                serviceError(distribution.message, 409, 'CANCELLATION_POLICY_NOT_CONFIGURED')
            );
        }

        const respondedAt = new Date();
        await cancellation.update({
            counterparty_response: 'CONFIRMED',
            counterparty_responded_at: respondedAt,
            counterparty_responded_by_user_id: currentUser.id
        }, { transaction });
        const resolved = await resolveCancellationInTransaction({
            job,
            cancellation,
            invariant,
            distribution,
            resolvedByUserId: currentUser.id,
            resolutionNote: 'MUTUAL_AGREEMENT_CONFIRMED',
            transaction
        });
        if (resolved.error) return rollbackWith(transaction, resolved.error);

        await transaction.commit();
        emitCancellationEvent({
            event: JOB_LIFECYCLE_EVENTS.CANCELLED,
            job,
            cancellation
        });
        return {
            EM: 'Mutual cancellation confirmed and resolved.',
            EC: 0,
            code: 'CANCELLATION_CONFIRMED',
            DT: buildCancellationDto(cancellation)
        };
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('[matchmaking] Failed to confirm lifecycle cancellation.', {
            job_id: jobId,
            cancellation_id: cancellationId,
            error: error?.message || 'Unknown error'
        });
        return serviceError('Unable to confirm cancellation.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const rejectCancellationService = async (jobId, cancellationId, currentUser, payload) => {
    if (!isValidUuid(jobId) || !isValidUuid(cancellationId)) {
        return serviceError('Invalid job or cancellation id.', 400, 'VALIDATION_ERROR');
    }
    const validatedPayload = validateCounterpartyResponsePayload(payload || {});
    if (!validatedPayload.valid) {
        return serviceError(validatedPayload.message, 400, 'VALIDATION_ERROR');
    }

    const transaction = await db.transaction();
    try {
        const context = await loadCounterpartyResponseContext({
            jobId,
            cancellationId,
            currentUser,
            transaction
        });
        if (context.error) return rollbackWith(transaction, context.error);
        const { job, cancellation } = context;

        if (cancellation.status === 'REVIEW_REQUIRED'
            && cancellation.counterparty_response === 'REJECTED') {
            await transaction.commit();
            return {
                EM: 'Cancellation rejection was already recorded for review.',
                EC: 0,
                code: 'CANCELLATION_ALREADY_REJECTED',
                DT: buildCancellationDto(cancellation)
            };
        }
        if (cancellation.status === 'RESOLVED'
            || cancellation.counterparty_response === 'CONFIRMED') {
            return rollbackWith(
                transaction,
                serviceError(
                    'Cancellation response has already been finalized.',
                    409,
                    'CANCELLATION_RESPONSE_CONFLICT'
                )
            );
        }
        if (job.current_status !== 'CANCELLATION_REVIEW'
            || cancellation.status !== 'AWAITING_COUNTERPARTY'
            || cancellation.reason_code !== 'MUTUAL_AGREEMENT'
            || cancellation.resolution_mode !== 'COUNTERPARTY_ACKNOWLEDGEMENT') {
            return rollbackWith(
                transaction,
                serviceError(
                    'Cancellation is not awaiting a counterparty response.',
                    409,
                    'INVALID_CANCELLATION_STATUS'
                )
            );
        }

        const respondedAt = new Date();
        await cancellation.update({
            status: 'REVIEW_REQUIRED',
            counterparty_response: 'REJECTED',
            counterparty_response_note: validatedPayload.responseNote,
            counterparty_responded_at: respondedAt,
            counterparty_responded_by_user_id: currentUser.id
        }, { transaction });
        await transaction.commit();

        emitCancellationEvent({
            event: JOB_LIFECYCLE_EVENTS.CANCELLATION_REJECTED,
            job,
            cancellation
        });
        emitCancellationEvent({
            event: JOB_LIFECYCLE_EVENTS.CANCELLATION_REVIEW_REQUIRED,
            job,
            cancellation
        });
        return {
            EM: 'Mutual cancellation was rejected and now requires review.',
            EC: 0,
            code: 'CANCELLATION_REJECTED_FOR_REVIEW',
            DT: buildCancellationDto(cancellation)
        };
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('[matchmaking] Failed to reject lifecycle cancellation.', {
            job_id: jobId,
            cancellation_id: cancellationId,
            error: error?.message || 'Unknown error'
        });
        return serviceError('Unable to reject cancellation.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

export {
    applyLifecycleCancellationInTransaction,
    confirmCancellationService,
    createCancellationService,
    emitCancellationEvent,
    getCurrentCancellationService,
    rejectCancellationService
};
