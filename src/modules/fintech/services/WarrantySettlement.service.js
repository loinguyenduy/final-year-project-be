import { Op } from 'sequelize';
import db from '../../../core/database/connection.js';
import { CONVERSATION_CLOSED_REASONS } from '../../chat/constants/chat.constants.js';
import Conversation from '../../chat/models/Conversation.model.js';
import { closeConversationRecord } from '../../chat/services/ConversationLifecycle.service.js';
import Job from '../../matchmaking/models/Job.model.js';
import JobCancellation from '../../matchmaking/models/JobCancellation.model.js';
import JobCompletionRequest from '../../matchmaking/models/JobCompletionRequest.model.js';
import JobQuote from '../../matchmaking/models/JobQuote.model.js';
import JobStatusHistory from '../../matchmaking/models/JobStatusHistory.model.js';
import JobWarranty from '../../matchmaking/models/JobWarranty.model.js';
import WarrantyClaim from '../../matchmaking/models/WarrantyClaim.model.js';
import {
    JOB_LIFECYCLE_EVENTS,
    emitJobLifecycleEvent
} from '../../matchmaking/sockets/JobLifecycle.gateway.js';
import {
    ACTIVE_CANCELLATION_STATUSES,
    parseDecimalHundredths,
    parseVndInteger
} from '../../matchmaking/utils/cancellationPolicy.util.js';
import { isValidUuid, serviceError } from '../../matchmaking/services/AcceptedJob.service.js';
import EContract from '../models/EContract.model.js';
import Transaction from '../models/Transaction.model.js';
import Wallet from '../models/Wallet.model.js';
import { calculateCompletionSplit } from '../utils/completionSettlement.util.js';

const ACTIVE_CLAIM_STATUSES = [
    'PENDING_REVIEW',
    'APPROVED_REWORK_REQUIRED',
    'REVIEW_REQUIRED'
];

const rollbackWith = async (transaction, result) => {
    if (!transaction.finished) await transaction.rollback();
    return result;
};

const getCompletionSettlementKeys = (job, request) => ({
    handyman: `job:${job.id}:completion:${request.id}:handyman-release`,
    platform: `job:${job.id}:completion:${request.id}:platform-fee`,
    warranty: `job:${job.id}:completion:${request.id}:warranty-hold`
});

const getWarrantyReleaseKey = (warranty) => `job:${warranty.job_id}:warranty:${warranty.id}:release`;

const resolveWarrantyTiming = (warrantyDays, startedAt = new Date()) => {
    const days = Number(warrantyDays);
    if (!Number.isInteger(days) || days <= 0) {
        return { valid: false, code: 'WARRANTY_POLICY_INCONSISTENT' };
    }
    const environment = String(process.env.NODE_ENV || 'development').toLowerCase();
    const rawOverride = process.env.JOB_WARRANTY_TEST_DELAY_MINUTES;
    const override = rawOverride === undefined || rawOverride === '' ? null : Number(rawOverride);
    const mayUseOverride = ['development', 'test'].includes(environment)
        && Number.isInteger(override)
        && override > 0;
    const durationMs = mayUseOverride
        ? override * 60 * 1000
        : days * 24 * 60 * 60 * 1000;
    return {
        valid: true,
        warrantyDays: days,
        startedAt,
        endsAt: new Date(startedAt.getTime() + durationMs),
        overrideMinutes: mayUseOverride ? override : null
    };
};

const loadRequiredWallets = async (job, transaction, walletTypes) => {
    const wallets = await Wallet.findAll({
        where: {
            [Op.or]: walletTypes.map((walletType) => (
                walletType.startsWith('SYSTEM_')
                    ? { user_id: null, wallet_type: walletType }
                    : { user_id: job.selected_handyman_id, wallet_type: walletType }
            ))
        },
        order: [['id', 'ASC']],
        transaction,
        lock: transaction.LOCK.UPDATE
    });
    const byType = new Map(wallets.map((wallet) => [wallet.wallet_type, wallet]));
    const missing = walletTypes.find((type) => !byType.get(type));
    if (missing) {
        return { error: serviceError(`Required wallet ${missing} was not found.`, 404, 'SETTLEMENT_WALLET_NOT_FOUND') };
    }
    if (wallets.some((wallet) => wallet.is_blocked)) {
        return { error: serviceError('A settlement wallet is blocked.', 409, 'SETTLEMENT_WALLET_BLOCKED') };
    }
    if (wallets.some((wallet) => wallet.currency !== 'VND')) {
        return { error: serviceError('Settlement wallets must use VND.', 409, 'FINANCIAL_DATA_INCONSISTENT') };
    }
    return { wallets: byType };
};

const loadCanonicalCompletionFinancialContext = async (job, transaction) => {
    if (job.current_status !== 'IN_PROGRESS') {
        return { error: serviceError('Job is not IN_PROGRESS.', 409, 'JOB_NOT_IN_PROGRESS') };
    }
    if (job.deposit_status !== 'HELD') {
        return { error: serviceError('The Job escrow is not held.', 409, 'FINANCIAL_DATA_INCONSISTENT') };
    }
    const activeCancellation = await JobCancellation.findOne({
        where: {
            job_id: job.id,
            acceptance_cycle: job.acceptance_cycle,
            status: { [Op.in]: ACTIVE_CANCELLATION_STATUSES }
        },
        transaction,
        lock: transaction.LOCK.UPDATE
    });
    if (activeCancellation) {
        return { error: serviceError('A blocking cancellation exists.', 409, 'BLOCKING_DISPUTE_ACTIVE') };
    }

    const quote = await JobQuote.findOne({
        where: {
            job_id: job.id,
            acceptance_cycle: job.acceptance_cycle,
            version: 1,
            status: 'ACCEPTED'
        },
        transaction,
        lock: transaction.LOCK.UPDATE
    });
    if (!quote) return { error: serviceError('Accepted Quote not found.', 409, 'FINANCIAL_DATA_INCONSISTENT') };
    const contract = await EContract.findOne({
        where: {
            job_id: job.id,
            acceptance_cycle: job.acceptance_cycle,
            quote_id: quote.id
        },
        transaction,
        lock: transaction.LOCK.UPDATE
    });
    if (!contract || contract.status !== 'ACTIVE') {
        return { error: serviceError('Active Contract not found.', 409, 'FINANCIAL_DATA_INCONSISTENT') };
    }
    const timing = resolveWarrantyTiming(contract.warranty_days);
    if (!timing.valid) {
        return { error: serviceError('Contract Warranty policy is invalid.', 409, timing.code) };
    }

    const total = parseVndInteger(contract.full_escrow_amount);
    const contractTotal = parseVndInteger(contract.quote_total_amount);
    const quoteTotal = parseVndInteger(quote.total_amount);
    const depositAmount = parseVndInteger(contract.deposit_amount);
    const remainingAmount = parseVndInteger(contract.remaining_payment_amount);
    const finalPrice = parseVndInteger(job.final_agreed_price);
    if (!total.valid || total.amount <= 0n
        || !contractTotal.valid || contractTotal.amount !== total.amount
        || !quoteTotal.valid || quoteTotal.amount !== total.amount
        || !depositAmount.valid || !remainingAmount.valid
        || depositAmount.amount + remainingAmount.amount !== total.amount
        || !finalPrice.valid || finalPrice.amount !== total.amount) {
        return { error: serviceError('Canonical Contract and Quote amounts are inconsistent.', 409, 'FINANCIAL_DATA_INCONSISTENT') };
    }

    const walletsResult = await loadRequiredWallets(
        job,
        transaction,
        ['SYSTEM_ESCROW', 'SYSTEM_PROFIT', 'HANDYMAN_MAIN']
    );
    if (walletsResult.error) return walletsResult;
    const systemEscrow = walletsResult.wallets.get('SYSTEM_ESCROW');
    const depositTransaction = await Transaction.findOne({
        where: {
            id: job.deposit_transaction_id,
            job_id: job.id,
            transaction_type: 'DEPOSIT_10',
            status: 'SUCCESS'
        },
        transaction,
        lock: transaction.LOCK.UPDATE
    });
    const parsedDepositTransaction = parseVndInteger(depositTransaction?.amount);
    if (!depositTransaction
        || depositTransaction.to_wallet_id !== systemEscrow.id
        || !parsedDepositTransaction.valid
        || parsedDepositTransaction.amount !== depositAmount.amount) {
        return { error: serviceError('Deposit ledger is inconsistent.', 409, 'FINANCIAL_DATA_INCONSISTENT') };
    }

    let remainingTransaction = null;
    if (remainingAmount.amount > 0n) {
        remainingTransaction = await Transaction.findOne({
            where: {
                id: contract.remaining_payment_transaction_id,
                job_id: job.id,
                quote_id: quote.id,
                acceptance_cycle: job.acceptance_cycle,
                transaction_type: 'SERVICE_REMAINING_PAYMENT',
                status: 'SUCCESS'
            },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        const parsedRemaining = parseVndInteger(remainingTransaction?.amount);
        if (!remainingTransaction
            || remainingTransaction.to_wallet_id !== systemEscrow.id
            || !parsedRemaining.valid
            || parsedRemaining.amount !== remainingAmount.amount) {
            return { error: serviceError('Remaining-payment ledger is inconsistent.', 409, 'FINANCIAL_DATA_INCONSISTENT') };
        }
    } else if (contract.remaining_payment_transaction_id) {
        return { error: serviceError('Zero remaining payment has an unexpected ledger reference.', 409, 'FINANCIAL_DATA_INCONSISTENT') };
    }

    const escrowBalance = parseDecimalHundredths(systemEscrow.balance);
    if (!escrowBalance.valid || escrowBalance.amount < total.amount * 100n) {
        return { error: serviceError('SYSTEM_ESCROW balance is insufficient.', 409, 'ESCROW_AMOUNT_INSUFFICIENT') };
    }
    return {
        quote,
        contract,
        total: total.amount,
        depositTransaction,
        remainingTransaction,
        wallets: walletsResult.wallets,
        timing
    };
};

const buildWarrantyDto = (warranty) => ({
    id: warranty.id,
    job_id: warranty.job_id,
    status: warranty.status,
    warranty_days: Number(warranty.warranty_days),
    started_at: warranty.started_at,
    ends_at: warranty.ends_at,
    expiry_override_minutes: warranty.expiry_override_minutes,
    total_amount: parseVndInteger(warranty.total_amount).amount?.toString() || null,
    handyman_immediate_amount: parseVndInteger(warranty.handyman_immediate_amount).amount?.toString() || null,
    platform_fee_amount: parseVndInteger(warranty.platform_fee_amount).amount?.toString() || null,
    held_amount: parseVndInteger(warranty.warranty_held_amount).amount?.toString() || null,
    released_amount: parseVndInteger(warranty.warranty_released_amount).amount?.toString() || '0',
    released_at: warranty.released_at
});

const validateExistingConfirmedSettlement = async (job, request, transaction) => {
    const warranty = await JobWarranty.findOne({
        where: { completion_request_id: request.id },
        transaction,
        lock: transaction.LOCK.UPDATE
    });
    const lifecycleValid = warranty && (
        (job.current_status === 'WARRANTY' && warranty.status !== 'COMPLETED')
        || (job.current_status === 'CLOSED' && warranty.status === 'COMPLETED' && warranty.released_at)
    );
    if (!lifecycleValid) {
        return { error: serviceError('Confirmed settlement state is inconsistent.', 409, 'FINANCIAL_DATA_INCONSISTENT') };
    }
    const keys = getCompletionSettlementKeys(job, request);
    const ledger = await Transaction.findAll({
        where: { idempotency_key: { [Op.in]: Object.values(keys) }, status: 'SUCCESS' },
        transaction,
        lock: transaction.LOCK.UPDATE
    });
    if (ledger.length !== 3) {
        return { error: serviceError('Confirmed settlement ledger is incomplete.', 409, 'FINANCIAL_DATA_INCONSISTENT') };
    }
    return { warranty };
};

const confirmCompletionSettlementService = async (jobId, requestId, currentUser) => {
    if (!isValidUuid(jobId) || !isValidUuid(requestId)) {
        return serviceError('Invalid Job or Completion Request id.', 400, 'VALIDATION_ERROR');
    }
    const transaction = await db.transaction();
    try {
        const job = await Job.findByPk(jobId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!job) return rollbackWith(transaction, serviceError('Job not found.', 404, 'JOB_NOT_FOUND'));
        if (currentUser?.role !== 'CUSTOMER' || job.customer_id !== currentUser.id) {
            return rollbackWith(transaction, serviceError('Only the Job Customer can confirm completion.', 403, 'NOT_JOB_CUSTOMER'));
        }
        const request = await JobCompletionRequest.findOne({
            where: { id: requestId, job_id: job.id, acceptance_cycle: job.acceptance_cycle },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!request) return rollbackWith(transaction, serviceError('Completion Request not found.', 404, 'COMPLETION_REQUEST_NOT_FOUND'));
        if (request.status === 'CONFIRMED') {
            const existing = await validateExistingConfirmedSettlement(job, request, transaction);
            if (existing.error) return rollbackWith(transaction, existing.error);
            await transaction.commit();
            return {
                EM: 'Completion was already confirmed.',
                EC: 0,
                code: 'COMPLETION_ALREADY_CONFIRMED',
                DT: { warranty: buildWarrantyDto(existing.warranty) }
            };
        }
        if (request.status !== 'PENDING') {
            return rollbackWith(transaction, serviceError('Completion Request is not pending.', 409, 'COMPLETION_REQUEST_NOT_PENDING'));
        }
        if (job.current_status !== 'IN_PROGRESS') {
            return rollbackWith(transaction, serviceError('Job is not IN_PROGRESS.', 409, 'JOB_NOT_IN_PROGRESS'));
        }

        const context = await loadCanonicalCompletionFinancialContext(job, transaction);
        if (context.error) return rollbackWith(transaction, context.error);
        const split = calculateCompletionSplit(context.total);
        if (!split.valid) {
            return rollbackWith(transaction, serviceError('Unable to calculate settlement split.', 409, split.code));
        }
        const existingWarranty = await JobWarranty.findOne({
            where: { job_id: job.id, acceptance_cycle: job.acceptance_cycle },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (existingWarranty) {
            return rollbackWith(transaction, serviceError('Completion settlement was already processed.', 409, 'COMPLETION_SETTLEMENT_ALREADY_PROCESSED'));
        }
        const keys = getCompletionSettlementKeys(job, request);
        const priorLedger = await Transaction.findOne({
            where: { idempotency_key: { [Op.in]: Object.values(keys) } },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (priorLedger) {
            return rollbackWith(transaction, serviceError('Completion settlement ledger already exists.', 409, 'COMPLETION_SETTLEMENT_ALREADY_PROCESSED'));
        }

        const now = new Date();
        const timing = resolveWarrantyTiming(context.contract.warranty_days, now);
        if (!timing.valid) {
            return rollbackWith(transaction, serviceError('Contract Warranty policy is invalid.', 409, timing.code));
        }
        const warranty = await JobWarranty.create({
            job_id: job.id,
            acceptance_cycle: job.acceptance_cycle,
            quote_id: context.quote.id,
            contract_id: context.contract.id,
            completion_request_id: request.id,
            customer_id: job.customer_id,
            handyman_id: job.selected_handyman_id,
            status: 'ACTIVE',
            warranty_days: timing.warrantyDays,
            started_at: timing.startedAt,
            ends_at: timing.endsAt,
            expiry_override_minutes: timing.overrideMinutes,
            total_amount: split.total.toString(),
            handyman_immediate_amount: split.handymanAmount.toString(),
            platform_fee_amount: split.platformAmount.toString(),
            warranty_held_amount: split.warrantyAmount.toString(),
            warranty_released_amount: '0'
        }, { transaction });

        const systemEscrow = context.wallets.get('SYSTEM_ESCROW');
        const systemProfit = context.wallets.get('SYSTEM_PROFIT');
        const handymanMain = context.wallets.get('HANDYMAN_MAIN');
        await systemEscrow.decrement('balance', {
            by: (split.handymanAmount + split.platformAmount).toString(),
            transaction
        });
        await handymanMain.increment('balance', { by: split.handymanAmount.toString(), transaction });
        await systemProfit.increment('balance', { by: split.platformAmount.toString(), transaction });

        const commonLedger = {
            status: 'SUCCESS',
            payment_method: 'INTERNAL',
            job_id: job.id,
            quote_id: context.quote.id,
            acceptance_cycle: job.acceptance_cycle,
            completion_request_id: request.id,
            warranty_id: warranty.id,
            payer_user_id: job.customer_id,
            expires_at: null
        };
        await Transaction.bulkCreate([
            {
                ...commonLedger,
                amount: split.handymanAmount.toString(),
                transaction_type: 'HANDYMAN_PARTIAL_RELEASE',
                description: `70% completion release for Job ${job.id}`,
                from_wallet_id: systemEscrow.id,
                to_wallet_id: handymanMain.id,
                idempotency_key: keys.handyman
            },
            {
                ...commonLedger,
                amount: split.platformAmount.toString(),
                transaction_type: 'PLATFORM_SERVICE_FEE',
                description: `15% platform service fee for Job ${job.id}`,
                from_wallet_id: systemEscrow.id,
                to_wallet_id: systemProfit.id,
                idempotency_key: keys.platform
            },
            {
                ...commonLedger,
                amount: split.warrantyAmount.toString(),
                transaction_type: 'WARRANTY_RESERVE_HOLD',
                description: `15% Warranty Reserve hold for Job ${job.id}`,
                from_wallet_id: systemEscrow.id,
                to_wallet_id: null,
                idempotency_key: keys.warranty
            }
        ], { transaction });

        await request.update({
            status: 'CONFIRMED',
            responded_at: now,
            responded_by_user_id: currentUser.id,
            rejection_reason: null,
            rejection_note: null
        }, { transaction });
        await job.update({ current_status: 'WARRANTY', deposit_status: 'DISTRIBUTED' }, { transaction });
        await JobStatusHistory.create({
            job_id: job.id,
            changed_by_user_id: currentUser.id,
            old_status: 'IN_PROGRESS',
            new_status: 'WARRANTY',
            reason: `CUSTOMER_CONFIRMED_COMPLETION:${request.id}`
        }, { transaction });
        await transaction.commit();

        const payload = {
            job_id: job.id,
            acceptance_cycle: Number(job.acceptance_cycle),
            completion_request_id: request.id,
            warranty_id: warranty.id,
            current_status: 'WARRANTY',
            warranty_status: 'ACTIVE',
            occurred_at: now
        };
        emitJobLifecycleEvent({
            event: JOB_LIFECYCLE_EVENTS.COMPLETION_CONFIRMED,
            userIds: [job.customer_id, job.selected_handyman_id],
            payload
        });
        emitJobLifecycleEvent({
            event: JOB_LIFECYCLE_EVENTS.WARRANTY_STARTED,
            userIds: [job.customer_id, job.selected_handyman_id],
            payload
        });
        return {
            EM: 'Completion confirmed and Warranty started successfully.',
            EC: 0,
            code: 'COMPLETION_CONFIRMED',
            DT: { warranty: buildWarrantyDto(warranty) }
        };
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('[fintech] Completion settlement failed.', {
            job_id: jobId,
            request_id: requestId,
            error: error?.message || 'Unknown error'
        });
        return serviceError('Unable to confirm completion.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const releaseWarrantyReserveInTransaction = async ({
    job,
    warranty,
    transaction,
    warrantyCompletionRequestId = null
}) => {
    const held = parseVndInteger(warranty.warranty_held_amount);
    const released = parseVndInteger(warranty.warranty_released_amount);
    if (!held.valid || held.amount <= 0n || !released.valid || released.amount !== 0n || warranty.released_at) {
        return { error: serviceError('Warranty financial data is inconsistent.', 409, 'FINANCIAL_DATA_INCONSISTENT') };
    }
    const hold = await Transaction.findOne({
        where: {
            warranty_id: warranty.id,
            transaction_type: 'WARRANTY_RESERVE_HOLD',
            status: 'SUCCESS'
        },
        transaction,
        lock: transaction.LOCK.UPDATE
    });
    const holdAmount = parseVndInteger(hold?.amount);
    if (!hold || !holdAmount.valid || holdAmount.amount !== held.amount) {
        return { error: serviceError('Warranty hold ledger is inconsistent.', 409, 'FINANCIAL_DATA_INCONSISTENT') };
    }
    const releaseKey = getWarrantyReleaseKey(warranty);
    const existingRelease = await Transaction.findOne({
        where: {
            [Op.or]: [
                { idempotency_key: releaseKey },
                { warranty_id: warranty.id, transaction_type: 'WARRANTY_RELEASE', status: 'SUCCESS' }
            ]
        },
        transaction,
        lock: transaction.LOCK.UPDATE
    });
    if (existingRelease) {
        return { error: serviceError('Warranty settlement was already processed.', 409, 'WARRANTY_SETTLEMENT_ALREADY_PROCESSED') };
    }
    const walletsResult = await loadRequiredWallets(job, transaction, ['SYSTEM_ESCROW', 'HANDYMAN_MAIN']);
    if (walletsResult.error) return walletsResult;
    const systemEscrow = walletsResult.wallets.get('SYSTEM_ESCROW');
    const handymanMain = walletsResult.wallets.get('HANDYMAN_MAIN');
    const escrowBalance = parseDecimalHundredths(systemEscrow.balance);
    if (!escrowBalance.valid || escrowBalance.amount < held.amount * 100n) {
        return { error: serviceError('SYSTEM_ESCROW balance is insufficient.', 409, 'ESCROW_AMOUNT_INSUFFICIENT') };
    }
    await systemEscrow.decrement('balance', { by: held.amount.toString(), transaction });
    await handymanMain.increment('balance', { by: held.amount.toString(), transaction });
    const releaseTransaction = await Transaction.create({
        amount: held.amount.toString(),
        transaction_type: 'WARRANTY_RELEASE',
        status: 'SUCCESS',
        payment_method: 'INTERNAL',
        description: `Warranty Reserve release for Job ${job.id}`,
        from_wallet_id: systemEscrow.id,
        to_wallet_id: handymanMain.id,
        job_id: job.id,
        quote_id: warranty.quote_id,
        acceptance_cycle: job.acceptance_cycle,
        payer_user_id: job.customer_id,
        completion_request_id: warranty.completion_request_id,
        warranty_id: warranty.id,
        warranty_completion_request_id: warrantyCompletionRequestId,
        idempotency_key: releaseKey,
        expires_at: null
    }, { transaction });
    return { releaseTransaction, releasedAmount: held.amount };
};

const releaseExpiredWarrantyService = async (warrantyId, now = new Date()) => {
    if (!isValidUuid(warrantyId)) {
        return serviceError('Invalid Warranty id.', 400, 'VALIDATION_ERROR');
    }
    const preliminary = await JobWarranty.findByPk(warrantyId, { attributes: ['id', 'job_id'] });
    if (!preliminary) return serviceError('Warranty not found.', 404, 'WARRANTY_NOT_FOUND');
    const transaction = await db.transaction();
    try {
        const job = await Job.findByPk(preliminary.job_id, { transaction, lock: transaction.LOCK.UPDATE });
        const warranty = await JobWarranty.findByPk(warrantyId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!job || !warranty) return rollbackWith(transaction, serviceError('Warranty not found.', 404, 'WARRANTY_NOT_FOUND'));
        if (warranty.status === 'COMPLETED' && warranty.released_at && job.current_status === 'CLOSED') {
            await transaction.commit();
            return { EM: 'Warranty was already released.', EC: 0, code: 'WARRANTY_ALREADY_RELEASED', DT: { warranty_id: warranty.id } };
        }
        if (warranty.status !== 'ACTIVE'
            || warranty.released_at
            || job.current_status !== 'WARRANTY'
            || new Date(warranty.ends_at) > now) {
            await transaction.commit();
            return { EM: 'Warranty is not eligible for release.', EC: 0, code: 'WARRANTY_NOT_DUE', DT: { warranty_id: warranty.id } };
        }
        const activeClaim = await WarrantyClaim.findOne({
            where: { warranty_id: warranty.id, status: { [Op.in]: ACTIVE_CLAIM_STATUSES } },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (activeClaim) {
            await transaction.commit();
            return { EM: 'Warranty release is blocked by an active Claim.', EC: 0, code: 'WARRANTY_RELEASE_BLOCKED_BY_CLAIM', DT: { warranty_id: warranty.id } };
        }
        const contract = await EContract.findOne({
            where: { id: warranty.contract_id, job_id: job.id },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!contract || contract.status !== 'ACTIVE') {
            return rollbackWith(transaction, serviceError('Active Contract not found.', 409, 'FINANCIAL_DATA_INCONSISTENT'));
        }
        const release = await releaseWarrantyReserveInTransaction({ job, warranty, transaction });
        if (release.error) return rollbackWith(transaction, release.error);

        await warranty.update({
            status: 'COMPLETED',
            warranty_released_amount: release.releasedAmount.toString(),
            released_at: now,
            release_transaction_id: release.releaseTransaction.id
        }, { transaction });
        await job.update({ current_status: 'CLOSED' }, { transaction });
        await contract.update({ status: 'COMPLETED' }, { transaction });
        await JobStatusHistory.create({
            job_id: job.id,
            changed_by_user_id: null,
            old_status: 'WARRANTY',
            new_status: 'CLOSED',
            reason: `WARRANTY_EXPIRED_AUTO_RELEASE:${warranty.id}`
        }, { transaction });
        const conversation = await Conversation.findOne({
            where: { job_id: job.id, acceptance_cycle: job.acceptance_cycle },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (conversation) {
            await closeConversationRecord(conversation, {
                reason: CONVERSATION_CLOSED_REASONS.JOB_CLOSED,
                transaction
            });
        }
        await transaction.commit();

        const payload = {
            job_id: job.id,
            acceptance_cycle: Number(job.acceptance_cycle),
            warranty_id: warranty.id,
            current_status: 'CLOSED',
            warranty_status: 'COMPLETED',
            occurred_at: now
        };
        emitJobLifecycleEvent({
            event: JOB_LIFECYCLE_EVENTS.WARRANTY_RELEASED,
            userIds: [job.customer_id, job.selected_handyman_id],
            payload
        });
        emitJobLifecycleEvent({
            event: JOB_LIFECYCLE_EVENTS.COMPLETED,
            userIds: [job.customer_id, job.selected_handyman_id],
            payload
        });
        return {
            EM: 'Warranty released and Job closed successfully.',
            EC: 0,
            code: 'WARRANTY_RELEASED',
            DT: { warranty: buildWarrantyDto(warranty), current_status: 'CLOSED' }
        };
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('[fintech] Warranty release failed.', { warranty_id: warrantyId, error: error?.message });
        return serviceError('Unable to release Warranty Reserve.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

export {
    buildWarrantyDto,
    calculateCompletionSplit,
    confirmCompletionSettlementService,
    loadCanonicalCompletionFinancialContext,
    releaseExpiredWarrantyService,
    releaseWarrantyReserveInTransaction,
    resolveWarrantyTiming
};
