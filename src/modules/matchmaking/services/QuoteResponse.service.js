import { Op } from 'sequelize';
import db from '../../../core/database/connection.js';
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
    parseVndInteger
} from '../utils/cancellationPolicy.util.js';
import { normalizeStoredQuote, toCanonicalMoneyString } from '../utils/quote.util.js';
import {
    calculateQuotePaymentAmounts,
    validateEmptyObjectPayload,
    validateQuoteRejectionPayload
} from '../utils/quotePayment.util.js';
import {
    isValidUuid,
    serviceError,
    validateAcceptedJobInvariants
} from './AcceptedJob.service.js';
import {
    applyLifecycleCancellationInTransaction,
    emitCancellationEvent
} from './LifecycleCancellation.service.js';
import {
    buildQuoteDto,
    findQuoteItems,
    validateQuoteContext
} from './Quote.service.js';

const rollbackWith = async (transaction, result) => {
    if (!transaction.finished) await transaction.rollback();
    return result;
};

const buildQuoteResponseAmounts = (job, quote, depositTransaction, canonicalTotal) => (
    calculateQuotePaymentAmounts({
        quoteTotalAmount: canonicalTotal,
        jobDepositAmount: job.deposit_amount,
        depositTransactionAmount: depositTransaction?.amount
    })
);

const buildAcceptanceResult = ({ code, message, job, quote, amounts }) => ({
    EM: message,
    EC: 0,
    code,
    DT: {
        job_id: job.id,
        quote_id: quote.id,
        acceptance_cycle: Number(job.acceptance_cycle),
        status: job.current_status,
        quote_total_amount: amounts.quoteTotal.toString(),
        deposit_amount: amounts.depositAmount.toString(),
        remaining_amount: amounts.remainingAmount.toString(),
        accepted_at: quote.accepted_at
    }
});

const validateStoredQuoteCanonicalTotal = (quote, normalized) => {
    const storedTotal = parseVndInteger(quote.total_amount);
    const storedSubtotal = parseVndInteger(quote.subtotal_amount);
    const storedDiscount = parseVndInteger(quote.discount_amount);
    const canonicalSubtotal = parseVndInteger(normalized.data.subtotal_amount);
    const canonicalDiscount = parseVndInteger(normalized.data.discount_amount);
    if (!storedTotal.valid
        || !storedSubtotal.valid
        || !storedDiscount.valid
        || !canonicalSubtotal.valid
        || !canonicalDiscount.valid
        || storedTotal.amount !== normalized.total
        || storedSubtotal.amount !== canonicalSubtotal.amount
        || storedDiscount.amount !== canonicalDiscount.amount) {
        return serviceError(
            'Stored Quote totals do not match the canonical Quote items.',
            409,
            'FINANCIAL_DATA_INCONSISTENT'
        );
    }
    return null;
};

const acceptQuoteService = async (jobId, quoteId, currentUser, payload = {}) => {
    if (!isValidUuid(jobId) || !isValidUuid(quoteId)) {
        return serviceError('Invalid job or quote id.', 400, 'VALIDATION_ERROR');
    }
    const bodyValidation = validateEmptyObjectPayload(payload, 'Accept Quote');
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
            return rollbackWith(transaction, serviceError('Quote not found.', 404, 'QUOTE_NOT_FOUND'));
        }

        const quote = await JobQuote.findOne({
            where: { id: quoteId, job_id: job.id },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!quote) {
            return rollbackWith(transaction, serviceError('Quote not found.', 404, 'QUOTE_NOT_FOUND'));
        }
        const contextError = validateQuoteContext(job, quote);
        if (contextError) return rollbackWith(transaction, contextError);

        const items = await findQuoteItems(quote.id, {
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (quote.status === 'REJECTED') {
            return rollbackWith(
                transaction,
                serviceError(
                    'A rejected Quote cannot be accepted.',
                    409,
                    'QUOTE_RESPONSE_CONFLICT'
                )
            );
        }

        const invariant = await validateAcceptedJobInvariants(job, { transaction });
        if (invariant.error) return rollbackWith(transaction, invariant.error);
        const normalized = normalizeStoredQuote(quote, items, invariant.selectedBid.proposed_price);
        if (!normalized.valid) {
            return rollbackWith(
                transaction,
                serviceError(normalized.message, 409, normalized.code)
            );
        }
        const canonicalError = validateStoredQuoteCanonicalTotal(quote, normalized);
        if (canonicalError) return rollbackWith(transaction, canonicalError);
        const amounts = buildQuoteResponseAmounts(
            job,
            quote,
            invariant.depositTransaction,
            normalized.total
        );
        if (!amounts.valid) {
            return rollbackWith(
                transaction,
                serviceError(amounts.message, 409, amounts.code)
            );
        }

        if (quote.status === 'ACCEPTED') {
            await transaction.commit();
            return buildAcceptanceResult({
                code: 'QUOTE_ALREADY_ACCEPTED',
                message: 'Quote was already accepted.',
                job,
                quote,
                amounts
            });
        }
        if (job.current_status !== 'QUOTE_PENDING' || quote.status !== 'SUBMITTED') {
            return rollbackWith(
                transaction,
                serviceError(
                    'Job and Quote are not awaiting a Customer response.',
                    409,
                    'QUOTE_LIFECYCLE_CONFLICT',
                    { current_status: job.current_status, quote_status: quote.status }
                )
            );
        }
        if (!invariant.customer.is_active || !invariant.selectedHandyman.is_active) {
            return rollbackWith(
                transaction,
                serviceError(
                    'Customer and selected handyman must both be active.',
                    409,
                    'PARTICIPANT_INACTIVE'
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

        const acceptedAt = new Date();
        await quote.update({
            status: 'ACCEPTED',
            customer_responded_at: acceptedAt,
            customer_response_by_user_id: currentUser.id,
            accepted_at: acceptedAt,
            rejected_at: null,
            rejection_reason: null,
            rejection_reason_text: null
        }, { transaction });
        await job.update({
            current_status: 'PAYMENT_PENDING',
            final_agreed_price: amounts.quoteTotal.toString()
        }, { transaction });
        await JobStatusHistory.create({
            job_id: job.id,
            changed_by_user_id: currentUser.id,
            old_status: 'QUOTE_PENDING',
            new_status: 'PAYMENT_PENDING',
            reason: `CUSTOMER_ACCEPTED_QUOTE:${quote.id}`
        }, { transaction });

        await transaction.commit();
        const eventPayload = {
            job_id: job.id,
            quote_id: quote.id,
            acceptance_cycle: Number(job.acceptance_cycle),
            status: 'PAYMENT_PENDING',
            quote_total_amount: amounts.quoteTotal.toString(),
            deposit_amount: amounts.depositAmount.toString(),
            remaining_amount: amounts.remainingAmount.toString(),
            accepted_at: acceptedAt
        };
        emitJobLifecycleEvent({
            event: JOB_LIFECYCLE_EVENTS.QUOTE_ACCEPTED,
            userIds: [job.customer_id, job.selected_handyman_id],
            payload: eventPayload
        });
        emitJobLifecycleEvent({
            event: JOB_LIFECYCLE_EVENTS.PAYMENT_REQUIRED,
            userIds: [job.customer_id, job.selected_handyman_id],
            payload: eventPayload
        });

        return buildAcceptanceResult({
            code: 'QUOTE_ACCEPTED',
            message: 'Quote accepted successfully. The remaining payment is now required.',
            job,
            quote,
            amounts
        });
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('[matchmaking] Failed to accept Quote.', {
            job_id: jobId,
            quote_id: quoteId,
            user_id: currentUser?.id,
            error: error?.message || 'Unknown error'
        });
        return serviceError('Unable to accept Quote.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const rejectQuoteService = async (jobId, quoteId, currentUser, payload) => {
    if (!isValidUuid(jobId) || !isValidUuid(quoteId)) {
        return serviceError('Invalid job or quote id.', 400, 'VALIDATION_ERROR');
    }
    const validatedPayload = validateQuoteRejectionPayload(payload);
    if (!validatedPayload.valid) {
        return serviceError(validatedPayload.message, 400, 'VALIDATION_ERROR');
    }

    const transaction = await db.transaction();
    try {
        const job = await Job.findByPk(jobId, {
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!job || currentUser?.role !== 'CUSTOMER' || job.customer_id !== currentUser.id) {
            return rollbackWith(transaction, serviceError('Quote not found.', 404, 'QUOTE_NOT_FOUND'));
        }
        const quote = await JobQuote.findOne({
            where: { id: quoteId, job_id: job.id },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!quote) {
            return rollbackWith(transaction, serviceError('Quote not found.', 404, 'QUOTE_NOT_FOUND'));
        }
        const contextError = validateQuoteContext(job, quote);
        if (contextError) return rollbackWith(transaction, contextError);

        if (quote.status === 'ACCEPTED') {
            return rollbackWith(
                transaction,
                serviceError(
                    'An accepted Quote cannot be rejected.',
                    409,
                    'QUOTE_RESPONSE_CONFLICT'
                )
            );
        }
        const cancellationPayload = {
            reason: validatedPayload.reason,
            reason_text: validatedPayload.reasonText
        };
        if (quote.status === 'REJECTED') {
            if (quote.customer_response_by_user_id !== currentUser.id
                || quote.rejection_reason !== validatedPayload.reason) {
                return rollbackWith(
                    transaction,
                    serviceError(
                        'Quote response has already been finalized.',
                        409,
                        'QUOTE_RESPONSE_CONFLICT'
                    )
                );
            }
            const retryOutcome = await applyLifecycleCancellationInTransaction({
                job,
                currentUser,
                payload: cancellationPayload,
                transaction
            });
            if (retryOutcome.error) return rollbackWith(transaction, retryOutcome.error);
            await transaction.commit();
            return {
                EM: 'Quote was already rejected.',
                EC: 0,
                code: 'QUOTE_ALREADY_REJECTED',
                DT: {
                    quote: buildQuoteDto(quote, []),
                    cancellation: retryOutcome.result.DT
                }
            };
        }
        if (job.current_status !== 'QUOTE_PENDING' || quote.status !== 'SUBMITTED') {
            return rollbackWith(
                transaction,
                serviceError(
                    'Job and Quote are not awaiting a Customer response.',
                    409,
                    'QUOTE_LIFECYCLE_CONFLICT',
                    { current_status: job.current_status, quote_status: quote.status }
                )
            );
        }

        const rejectedAt = new Date();
        await quote.update({
            status: 'REJECTED',
            customer_responded_at: rejectedAt,
            customer_response_by_user_id: currentUser.id,
            accepted_at: null,
            rejected_at: rejectedAt,
            rejection_reason: validatedPayload.reason,
            rejection_reason_text: validatedPayload.reasonText
        }, { transaction });
        const cancellationOutcome = await applyLifecycleCancellationInTransaction({
            job,
            currentUser,
            payload: cancellationPayload,
            transaction
        });
        if (cancellationOutcome.error) {
            return rollbackWith(transaction, cancellationOutcome.error);
        }
        if (cancellationOutcome.result.code !== 'CANCELLATION_RESOLVED') {
            return rollbackWith(
                transaction,
                serviceError(
                    'Quote rejection policy did not resolve the cancellation.',
                    409,
                    'CANCELLATION_POLICY_NOT_CONFIGURED'
                )
            );
        }

        await transaction.commit();
        emitJobLifecycleEvent({
            event: JOB_LIFECYCLE_EVENTS.QUOTE_REJECTED,
            userIds: [job.customer_id, job.selected_handyman_id],
            payload: {
                job_id: job.id,
                quote_id: quote.id,
                acceptance_cycle: Number(job.acceptance_cycle),
                quote_status: 'REJECTED',
                job_status: 'CANCELLED',
                reason: validatedPayload.reason,
                rejected_at: rejectedAt
            }
        });
        if (cancellationOutcome.event) {
            emitCancellationEvent({
                event: cancellationOutcome.event,
                job,
                cancellation: cancellationOutcome.cancellation
            });
        }

        return {
            EM: 'Quote rejected and Job cancellation resolved successfully.',
            EC: 0,
            code: 'QUOTE_REJECTED',
            DT: {
                quote: buildQuoteDto(quote, []),
                cancellation: cancellationOutcome.result.DT
            }
        };
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('[matchmaking] Failed to reject Quote.', {
            job_id: jobId,
            quote_id: quoteId,
            user_id: currentUser?.id,
            error: error?.message || 'Unknown error'
        });
        return serviceError('Unable to reject Quote.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

export {
    acceptQuoteService,
    rejectQuoteService
};
