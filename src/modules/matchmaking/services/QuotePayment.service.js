import { Op } from 'sequelize';
import db from '../../../core/database/connection.js';
import EContract from '../../fintech/models/EContract.model.js';
import Transaction from '../../fintech/models/Transaction.model.js';
import Wallet from '../../fintech/models/Wallet.model.js';
import Job from '../models/Job.model.js';
import JobCancellation from '../models/JobCancellation.model.js';
import JobQuote from '../models/JobQuote.model.js';
import JobStatusHistory from '../models/JobStatusHistory.model.js';
import {
    JOB_LIFECYCLE_EVENTS,
    emitJobLifecycleEvent
} from '../sockets/JobLifecycle.gateway.js';
import {
    ACTIVE_CANCELLATION_STATUSES,
    parseDecimalHundredths,
    parseVndInteger
} from '../utils/cancellationPolicy.util.js';
import { normalizeStoredQuote } from '../utils/quote.util.js';
import {
    buildContractDto,
    buildPaymentSummaryDto,
    buildQuoteItemSnapshot,
    calculateQuotePaymentAmounts,
    createContractIdentity,
    validateEmptyObjectPayload
} from '../utils/quotePayment.util.js';
import {
    isValidUuid,
    serviceError,
    validateAcceptedJobInvariants
} from './AcceptedJob.service.js';
import { findQuoteItems, validateQuoteContext } from './Quote.service.js';

const rollbackWith = async (transaction, result) => {
    if (!transaction.finished) await transaction.rollback();
    return result;
};

// Dùng idempotency key để xác định giao dịch thanh toán còn lại cho một công việc và báo giá cụ thể.
const getRemainingPaymentKey = (job, quote) => (
    `job:${job.id}:cycle:${job.acceptance_cycle}:quote:${quote.id}:remaining-payment`
);


// Nếu cùng một quote, cùng job và cùng acceptance cycle được submit lại 10 lần, 
// cả 10 lần đều tạo ra đúng một chuỗi.

const validateCanonicalQuote = (quote, items, bidAmount) => {
    const normalized = normalizeStoredQuote(quote, items, bidAmount);
    if (!normalized.valid) return normalized;
    const storedTotal = parseVndInteger(quote.total_amount);
    const storedSubtotal = parseVndInteger(quote.subtotal_amount);
    const storedDiscount = parseVndInteger(quote.discount_amount);
    const canonicalSubtotal = parseVndInteger(normalized.data.subtotal_amount);
    if (!storedTotal.valid
        || !storedSubtotal.valid
        || !storedDiscount.valid
        || !canonicalSubtotal.valid
        || storedTotal.amount !== normalized.total
        || storedSubtotal.amount !== canonicalSubtotal.amount
        || storedDiscount.amount !== 0n) {
        return {
            valid: false,
            code: 'FINANCIAL_DATA_INCONSISTENT',
            message: 'Stored Quote totals do not match the canonical Quote items.'
        };
    }
    return normalized;
};

const validatePaymentRelationships = ({ job, quote, invariant }) => {
    if (quote.status !== 'ACCEPTED'
        || !quote.accepted_at
        || quote.customer_response_by_user_id !== job.customer_id) {
        return serviceError(
            'Accepted Quote response metadata is inconsistent.',
            409,
            'FINANCIAL_DATA_INCONSISTENT'
        );
    }
    if (!invariant.customer.is_active || !invariant.selectedHandyman.is_active) {
        return serviceError(
            'Customer and selected handyman must both be active.',
            409,
            'PARTICIPANT_INACTIVE'
        );
    }
    return null;
};

const loadAcceptedQuoteUnderLock = async (job, transaction) => {
    const quote = await JobQuote.findOne({
        where: {
            job_id: job.id,
            acceptance_cycle: job.acceptance_cycle,
            version: 1
        },
        transaction,
        lock: transaction.LOCK.UPDATE
    });
    if (!quote) return { error: serviceError('Accepted Quote not found.', 404, 'QUOTE_NOT_FOUND') };
    const contextError = validateQuoteContext(job, quote);
    if (contextError) return { error: contextError };
    if (quote.status !== 'ACCEPTED') {
        return {
            error: serviceError(
                'Quote must be accepted before paying the remaining amount.',
                409,
                'QUOTE_NOT_ACCEPTED',
                { quote_status: quote.status }
            )
        };
    }
    const items = await findQuoteItems(quote.id, {
        transaction,
        lock: transaction.LOCK.UPDATE
    });
    return { quote, items };
};

const buildCompletedPaymentResult = ({ code, message, job, quote, contract, amounts }) => ({
    EM: message,
    EC: 0,
    code,
    DT: {
        payment: buildPaymentSummaryDto({ job, quote, contract, amounts }),
        contract: buildContractDto(contract),
        job_status: job.current_status,
        in_progress_at: job.in_progress_at
    }
});

// kiểm tra tính hợp lệ của trạng thái thanh toán còn lại cho một công việc và báo giá cụ thể.
const validateCompletedPaymentState = async ({
    job,
    quote,
    contract,
    amounts,
    transaction
}) => {
    if (!contract
        || contract.status !== 'ACTIVE'
        || contract.quote_id !== quote.id
        || Number(contract.acceptance_cycle) !== Number(job.acceptance_cycle)) {
        return serviceError(
            'The completed Job Contract is missing or inconsistent.',
            409,
            'PAYMENT_STATE_INCONSISTENT'
        );
    }
    // deterministic idempotency 
    const paymentKey = getRemainingPaymentKey(job, quote);
    const payment = await Transaction.findOne({
        where: { idempotency_key: paymentKey },
        transaction,
        lock: transaction.LOCK.UPDATE
    });
    if (amounts.remainingAmount === 0n) {
        if (payment || contract.remaining_payment_transaction_id) {
            return serviceError(
                'A zero-remaining Contract has an unexpected payment transaction.',
                409,
                'PAYMENT_STATE_INCONSISTENT'
            );
        }
        return null;
    }
    const paidAmount = parseVndInteger(payment?.amount);
    if (!payment
        || payment.transaction_type !== 'SERVICE_REMAINING_PAYMENT'
        || payment.status !== 'SUCCESS'
        || payment.job_id !== job.id
        || payment.quote_id !== quote.id
        || Number(payment.acceptance_cycle) !== Number(job.acceptance_cycle)
        || payment.payer_user_id !== job.customer_id
        || !paidAmount.valid
        || paidAmount.amount !== amounts.remainingAmount
        || contract.remaining_payment_transaction_id !== payment.id) {
        return serviceError(
            'The successful remaining payment is missing or inconsistent.',
            409,
            'PAYMENT_STATE_INCONSISTENT'
        );
    }
    return null;
};

const payRemainingAmountService = async (jobId, currentUser, payload = {}) => {
    if (!isValidUuid(jobId)) {
        return serviceError('Invalid job id.', 400, 'VALIDATION_ERROR');
    }
    const bodyValidation = validateEmptyObjectPayload(payload, 'Remaining payment');
    if (!bodyValidation.valid) {
        return serviceError(bodyValidation.message, 400, 'VALIDATION_ERROR');
    }

    const transaction = await db.transaction();
    try {
        const job = await Job.findByPk(jobId, {
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!job || currentUser?.role !== 'CUSTOMER' || job.customer_id !== currentUser.id) {
            return rollbackWith(
                transaction,
                serviceError('Payment summary not found.', 404, 'PAYMENT_SUMMARY_NOT_FOUND')
            );
        }

        const quoteContext = await loadAcceptedQuoteUnderLock(job, transaction);
        if (quoteContext.error) return rollbackWith(transaction, quoteContext.error);
        const { quote, items } = quoteContext;

        const invariant = await validateAcceptedJobInvariants(job, { transaction });
        if (invariant.error) return rollbackWith(transaction, invariant.error);
        const relationshipError = validatePaymentRelationships({ job, quote, invariant });
        if (relationshipError) return rollbackWith(transaction, relationshipError);
        const normalized = validateCanonicalQuote(
            quote,
            items,
            invariant.selectedBid.proposed_price
        );
        if (!normalized.valid) {
            return rollbackWith(
                transaction,
                serviceError(normalized.message, 409, normalized.code)
            );
        }
        if (!Number.isInteger(normalized.data.warranty_days)
            || normalized.data.warranty_days <= 0) {
            return rollbackWith(
                transaction,
                serviceError(
                    'The accepted Quote must provide at least one Warranty day before a Contract can be created.',
                    409,
                    'WARRANTY_POLICY_INCONSISTENT'
                )
            );
        }
        const amounts = calculateQuotePaymentAmounts({
            quoteTotalAmount: normalized.total,
            jobDepositAmount: job.deposit_amount,
            depositTransactionAmount: invariant.depositTransaction.amount
        });
        if (!amounts.valid) {
            return rollbackWith(
                transaction,
                serviceError(amounts.message, 409, amounts.code)
            );
        }

        let existingContract = null;
        if (job.current_status === 'IN_PROGRESS') {
            existingContract = await EContract.findOne({
                where: {
                    job_id: job.id,
                    acceptance_cycle: job.acceptance_cycle,
                    quote_id: quote.id
                },
                transaction,
                lock: transaction.LOCK.UPDATE
            });
            const completedStateError = await validateCompletedPaymentState({
                job,
                quote,
                contract: existingContract,
                amounts,
                transaction
            });
            if (completedStateError) return rollbackWith(transaction, completedStateError);
            await transaction.commit();
            return buildCompletedPaymentResult({
                code: 'PAYMENT_ALREADY_COMPLETED',
                message: 'The remaining payment was already completed.',
                job,
                quote,
                contract: existingContract,
                amounts
            });
        }
        if (job.current_status !== 'PAYMENT_PENDING') {
            return rollbackWith(
                transaction,
                serviceError(
                    'Job is not awaiting the remaining payment.',
                    409,
                    'INVALID_JOB_STATUS',
                    { current_status: job.current_status }
                )
            );
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
            return rollbackWith(
                transaction,
                serviceError(
                    'A cancellation is active for this Job.',
                    409,
                    'CANCELLATION_ALREADY_ACTIVE',
                    { cancellation_id: activeCancellation.id }
                )
            );
        }

        const customerWallet = await Wallet.findOne({
            where: { user_id: job.customer_id, wallet_type: 'CUSTOMER_MAIN' },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!customerWallet) {
            return rollbackWith(
                transaction,
                serviceError('Customer main wallet not found.', 404, 'CUSTOMER_WALLET_NOT_FOUND')
            );
        }
        const systemEscrow = await Wallet.findOne({
            where: { user_id: null, wallet_type: 'SYSTEM_ESCROW' },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!systemEscrow) {
            return rollbackWith(
                transaction,
                serviceError('SYSTEM_ESCROW wallet not found.', 404, 'SYSTEM_ESCROW_WALLET_NOT_FOUND')
            );
        }
        if (customerWallet.is_blocked || systemEscrow.is_blocked) {
            return rollbackWith(
                transaction,
                serviceError(
                    'A wallet required for remaining payment is blocked.',
                    409,
                    'PAYMENT_WALLET_BLOCKED'
                )
            );
        }
        if (customerWallet.currency !== 'VND' || systemEscrow.currency !== 'VND') {
            return rollbackWith(
                transaction,
                serviceError('Payment wallets must use VND.', 409, 'FINANCIAL_DATA_INCONSISTENT')
            );
        }

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
        const lockedAmounts = calculateQuotePaymentAmounts({
            quoteTotalAmount: normalized.total,
            jobDepositAmount: job.deposit_amount,
            depositTransactionAmount: depositTransaction?.amount
        });
        if (!depositTransaction
            || depositTransaction.from_wallet_id !== customerWallet.id
            || depositTransaction.to_wallet_id !== systemEscrow.id
            || !lockedAmounts.valid) {
            return rollbackWith(
                transaction,
                serviceError(
                    lockedAmounts.message || 'Deposit transaction is inconsistent.',
                    409,
                    'FINANCIAL_DATA_INCONSISTENT'
                )
            );
        }

        const priorDepositRelease = await Transaction.findOne({
            where: {
                reference_transaction_id: depositTransaction.id,
                status: 'SUCCESS',
                transaction_type: {
                    [Op.in]: [
                        'DEPOSIT_REFUND',
                        'CANCELLATION_REFUND',
                        'CANCELLATION_COMPENSATION',
                        'CANCELLATION_PLATFORM_FEE'
                    ]
                }
            },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (priorDepositRelease) {
            return rollbackWith(
                transaction,
                serviceError(
                    'The held deposit has already been released.',
                    409,
                    'FINANCIAL_DATA_INCONSISTENT'
                )
            );
        }

        const paymentKey = getRemainingPaymentKey(job, quote);
        const existingPayment = await Transaction.findOne({
            where: {
                [Op.or]: [
                    { idempotency_key: paymentKey },
                    {
                        job_id: job.id,
                        acceptance_cycle: job.acceptance_cycle,
                        quote_id: quote.id,
                        transaction_type: 'SERVICE_REMAINING_PAYMENT',
                        status: 'SUCCESS'
                    }
                ]
            },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (existingPayment) {
            return rollbackWith(
                transaction,
                serviceError(
                    'A successful remaining payment exists without a completed Contract.',
                    409,
                    'PAYMENT_STATE_INCONSISTENT'
                )
            );
        }

        existingContract = await EContract.findOne({
            where: {
                job_id: job.id,
                acceptance_cycle: job.acceptance_cycle,
                quote_id: quote.id
            },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (existingContract) {
            return rollbackWith(
                transaction,
                serviceError(
                    'A Contract already exists before payment completion.',
                    409,
                    'PAYMENT_STATE_INCONSISTENT'
                )
            );
        }

        const customerBalance = parseDecimalHundredths(customerWallet.balance);
        const escrowBalance = parseDecimalHundredths(systemEscrow.balance);
        const requiredHundredths = lockedAmounts.remainingAmount * 100n;
        if (!customerBalance.valid || !escrowBalance.valid) {
            return rollbackWith(
                transaction,
                serviceError('Payment wallet balance is invalid.', 409, 'FINANCIAL_DATA_INCONSISTENT')
            );
        }
        if (customerBalance.amount < requiredHundredths) {
            return rollbackWith(
                transaction,
                serviceError(
                    'Customer wallet does not have enough balance.',
                    409,
                    'INSUFFICIENT_BALANCE',
                    {
                        required_amount: lockedAmounts.remainingAmount.toString(),
                        missing_amount: (
                            (requiredHundredths - customerBalance.amount + 99n) / 100n
                        ).toString()
                    }
                )
            );
        }

        let paymentTransaction = null;
        if (lockedAmounts.remainingAmount > 0n) {
            await customerWallet.decrement('balance', {
                by: lockedAmounts.remainingAmount.toString(),
                transaction
            });
            await systemEscrow.increment('balance', {
                by: lockedAmounts.remainingAmount.toString(),
                transaction
            });
            paymentTransaction = await Transaction.create({
                amount: lockedAmounts.remainingAmount.toString(),
                transaction_type: 'SERVICE_REMAINING_PAYMENT',
                status: 'SUCCESS',
                payment_method: 'INTERNAL',
                payment_gateway_code: null,
                description: `Remaining service payment for Job ${job.id}`,
                from_wallet_id: customerWallet.id,
                to_wallet_id: systemEscrow.id,
                job_id: job.id,
                quote_id: quote.id,
                acceptance_cycle: job.acceptance_cycle,
                payer_user_id: job.customer_id,
                reference_transaction_id: depositTransaction.id,
                cancellation_id: null,
                idempotency_key: paymentKey,
                expires_at: null
            }, { transaction });
        }

        const remainingPaymentLedger = await Transaction.findAll({
            where: {
                job_id: job.id,
                acceptance_cycle: job.acceptance_cycle,
                quote_id: quote.id,
                transaction_type: 'SERVICE_REMAINING_PAYMENT',
                status: 'SUCCESS'
            },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        let remainingLedgerAmount = 0n;
        let ledgerIsConsistent = remainingPaymentLedger.length <= 1;
        for (const ledgerTransaction of remainingPaymentLedger) {
            const ledgerAmount = parseVndInteger(ledgerTransaction.amount);
            ledgerIsConsistent = ledgerIsConsistent
                && ledgerAmount.valid
                && ledgerTransaction.from_wallet_id === customerWallet.id
                && ledgerTransaction.to_wallet_id === systemEscrow.id
                && ledgerTransaction.payer_user_id === job.customer_id
                && ledgerTransaction.idempotency_key === paymentKey;
            if (ledgerAmount.valid) remainingLedgerAmount += ledgerAmount.amount;
        }
        const jobEscrowLiability = lockedAmounts.depositAmount + remainingLedgerAmount;
        if (!ledgerIsConsistent || jobEscrowLiability !== lockedAmounts.quoteTotal) {
            return rollbackWith(
                transaction,
                serviceError(
                    'Job escrow liability does not equal the accepted Quote total.',
                    409,
                    'FINANCIAL_DATA_INCONSISTENT'
                )
            );
        }

        const completedAt = new Date();
        const contractIdentity = createContractIdentity(completedAt);
        const contract = await EContract.create({
            id: contractIdentity.id,
            job_id: job.id,
            acceptance_cycle: job.acceptance_cycle,
            quote_id: quote.id,
            customer_id: job.customer_id,
            handyman_id: job.selected_handyman_id,
            selected_bid_id: job.selected_bid_id,
            remaining_payment_transaction_id: paymentTransaction?.id || null,
            contract_number: contractIdentity.contractNumber,
            status: 'ACTIVE',
            currency: 'VND',
            subtotal_amount: normalized.data.subtotal_amount,
            discount_amount: 0,
            quote_total_amount: lockedAmounts.quoteTotal.toString(),
            deposit_amount: lockedAmounts.depositAmount.toString(),
            remaining_payment_amount: lockedAmounts.remainingAmount.toString(),
            full_escrow_amount: lockedAmounts.quoteTotal.toString(),
            problem_summary: normalized.data.problem_summary,
            inspection_notes: normalized.data.inspection_notes,
            recommended_solution: normalized.data.recommended_solution,
            estimated_duration_minutes: normalized.data.estimated_duration_minutes,
            warranty_days: normalized.data.warranty_days,
            bid_reference_amount: normalized.data.bid_reference_amount,
            variance_amount: normalized.data.variance_amount,
            variance_percent: normalized.data.variance_percent,
            variance_reason: normalized.data.variance_reason,
            variance_reason_text: normalized.data.variance_reason_text,
            quote_items_snapshot: normalized.items.map(buildQuoteItemSnapshot),
            customer_name_snapshot: invariant.customer.full_name,
            handyman_name_snapshot: invariant.selectedHandyman.full_name,
            service_address_snapshot: job.service_address,
            customer_accepted_at: quote.accepted_at,
            payment_completed_at: completedAt,
            effective_at: completedAt,
            pdf_url: null,
            customer_otp_signature: null,
            agreed_price: lockedAmounts.quoteTotal.toString(),
            generated_at: completedAt
        }, { transaction });

        await job.update({
            current_status: 'IN_PROGRESS',
            in_progress_at: completedAt
        }, { transaction });
        await JobStatusHistory.create({
            job_id: job.id,
            changed_by_user_id: currentUser.id,
            old_status: 'PAYMENT_PENDING',
            new_status: 'IN_PROGRESS',
            reason: `CUSTOMER_COMPLETED_REMAINING_PAYMENT:${quote.id}`
        }, { transaction });

        await transaction.commit();
        const eventPayload = {
            job_id: job.id,
            quote_id: quote.id,
            acceptance_cycle: Number(job.acceptance_cycle),
            status: 'IN_PROGRESS',
            quote_total_amount: lockedAmounts.quoteTotal.toString(),
            deposit_amount: lockedAmounts.depositAmount.toString(),
            remaining_amount: lockedAmounts.remainingAmount.toString(),
            contract_id: contract.id,
            contract_number: contract.contract_number,
            payment_completed_at: completedAt,
            in_progress_at: completedAt
        };
        emitJobLifecycleEvent({
            event: JOB_LIFECYCLE_EVENTS.PAYMENT_COMPLETED,
            userIds: [job.customer_id, job.selected_handyman_id],
            payload: eventPayload
        });
        emitJobLifecycleEvent({
            event: JOB_LIFECYCLE_EVENTS.IN_PROGRESS,
            userIds: [job.customer_id, job.selected_handyman_id],
            payload: eventPayload
        });

        return buildCompletedPaymentResult({
            code: 'PAYMENT_COMPLETED',
            message: 'Remaining payment completed and Contract activated successfully.',
            job,
            quote,
            contract,
            amounts: lockedAmounts
        });
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('[matchmaking] Failed to complete remaining payment.', {
            job_id: jobId,
            user_id: currentUser?.id,
            error: error?.message || 'Unknown error'
        });
        return serviceError('Unable to complete remaining payment.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const getPaymentSummaryService = async (jobId, currentUser) => {
    if (!isValidUuid(jobId)) {
        return serviceError('Invalid job id.', 400, 'VALIDATION_ERROR');
    }
    try {
        const job = await Job.findByPk(jobId);
        if (!job) return serviceError('Payment summary not found.', 404, 'PAYMENT_SUMMARY_NOT_FOUND');
        const canRead = currentUser?.role === 'ADMIN'
            || (currentUser?.role === 'CUSTOMER' && job.customer_id === currentUser.id)
            || (currentUser?.role === 'HANDYMAN' && job.selected_handyman_id === currentUser.id);
        if (!canRead) {
            return serviceError('Payment summary not found.', 404, 'PAYMENT_SUMMARY_NOT_FOUND');
        }

        const quote = await JobQuote.findOne({
            where: {
                job_id: job.id,
                acceptance_cycle: job.acceptance_cycle,
                version: 1,
                status: 'ACCEPTED'
            }
        });
        if (!quote) {
            return serviceError('Payment summary not found.', 404, 'PAYMENT_SUMMARY_NOT_FOUND');
        }
        const contextError = validateQuoteContext(job, quote);
        if (contextError) return contextError;
        const items = await findQuoteItems(quote.id);
        const invariant = await validateAcceptedJobInvariants(job);
        if (invariant.error) return invariant.error;
        const normalized = validateCanonicalQuote(
            quote,
            items,
            invariant.selectedBid.proposed_price
        );
        if (!normalized.valid) {
            return serviceError(normalized.message, 409, normalized.code);
        }
        const amounts = calculateQuotePaymentAmounts({
            quoteTotalAmount: normalized.total,
            jobDepositAmount: job.deposit_amount,
            depositTransactionAmount: invariant.depositTransaction.amount
        });
        if (!amounts.valid) return serviceError(amounts.message, 409, amounts.code);
        const contract = await EContract.findOne({
            where: {
                job_id: job.id,
                acceptance_cycle: job.acceptance_cycle,
                quote_id: quote.id
            }
        });

        return {
            EM: 'Payment summary retrieved successfully.',
            EC: 0,
            code: 'PAYMENT_SUMMARY_RETRIEVED',
            DT: buildPaymentSummaryDto({ job, quote, contract, amounts })
        };
    } catch (error) {
        console.error('[matchmaking] Failed to retrieve payment summary.', {
            job_id: jobId,
            error: error?.message || 'Unknown error'
        });
        return serviceError('Unable to retrieve payment summary.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const getContractService = async (jobId, currentUser) => {
    if (!isValidUuid(jobId)) {
        return serviceError('Invalid job id.', 400, 'VALIDATION_ERROR');
    }
    try {
        const job = await Job.findByPk(jobId);
        if (!job) return serviceError('Contract not found.', 404, 'CONTRACT_NOT_FOUND');
        const canRead = currentUser?.role === 'ADMIN'
            || (currentUser?.role === 'CUSTOMER' && job.customer_id === currentUser.id)
            || (currentUser?.role === 'HANDYMAN' && job.selected_handyman_id === currentUser.id);
        if (!canRead) return serviceError('Contract not found.', 404, 'CONTRACT_NOT_FOUND');

        const contract = await EContract.findOne({
            where: { job_id: job.id, acceptance_cycle: job.acceptance_cycle }
        });
        if (!contract) return serviceError('Contract not found.', 404, 'CONTRACT_NOT_FOUND');

        return {
            EM: 'Contract retrieved successfully.',
            EC: 0,
            code: 'CONTRACT_RETRIEVED',
            DT: { contract: buildContractDto(contract) }
        };
    } catch (error) {
        console.error('[matchmaking] Failed to retrieve Contract.', {
            job_id: jobId,
            error: error?.message || 'Unknown error'
        });
        return serviceError('Unable to retrieve Contract.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

export {
    getContractService,
    getPaymentSummaryService,
    payRemainingAmountService
};
