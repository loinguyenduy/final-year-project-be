import db from '../../../core/database/connection.js';
import EvidenceVault from '../../fintech/models/EvidenceVault.model.js';
import Job from '../models/Job.model.js';
import JobQuote from '../models/JobQuote.model.js';
import JobQuoteItem from '../models/JobQuoteItem.model.js';
import JobStatusHistory from '../models/JobStatusHistory.model.js';
import {
    isValidUuid,
    serviceError,
    validateAcceptedJobInvariants
} from './AcceptedJob.service.js';
import {
    buildSubmitReadiness,
    getQuoteConfig,
    normalizeStoredQuote,
    parsePositiveBidReference,
    toCanonicalMoneyString,
    validateDraftPayload
} from '../utils/quote.util.js';
import {
    JOB_LIFECYCLE_EVENTS,
    emitJobLifecycleEvent
} from '../sockets/JobLifecycle.gateway.js';

const buildQuoteItemDto = (item) => ({
    id: item.id,
    item_type: item.item_type,
    description: item.description,
    quantity: toCanonicalMoneyString(item.quantity),
    unit: item.unit,
    unit_price: toCanonicalMoneyString(item.unit_price),
    line_total: toCanonicalMoneyString(item.line_total),
    sort_order: Number(item.sort_order)
});

const buildQuoteDto = (quote, items = [], {
    includeDraftRevision = false,
    readiness = undefined
} = {}) => ({
    id: quote.id,
    job_id: quote.job_id,
    acceptance_cycle: Number(quote.acceptance_cycle),
    version: Number(quote.version),
    ...(includeDraftRevision ? { draft_revision: Number(quote.draft_revision) } : {}),
    status: quote.status,
    problem_summary: quote.problem_summary,
    inspection_notes: quote.inspection_notes,
    recommended_solution: quote.recommended_solution,
    estimated_duration_minutes: quote.estimated_duration_minutes,
    warranty_days: quote.warranty_days,
    subtotal_amount: toCanonicalMoneyString(quote.subtotal_amount),
    discount_amount: toCanonicalMoneyString(quote.discount_amount),
    total_amount: toCanonicalMoneyString(quote.total_amount),
    currency: quote.currency,
    bid_reference_amount: toCanonicalMoneyString(quote.bid_reference_amount),
    variance_amount: toCanonicalMoneyString(quote.variance_amount),
    variance_percent: toCanonicalMoneyString(quote.variance_percent),
    variance_reason: quote.variance_reason,
    variance_reason_text: quote.variance_reason_text,
    submitted_at: quote.submitted_at,
    customer_responded_at: quote.customer_responded_at,
    accepted_at: quote.accepted_at,
    rejected_at: quote.rejected_at,
    rejection_reason: quote.rejection_reason,
    rejection_reason_text: quote.rejection_reason_text,
    created_at: quote.createdAt,
    updated_at: quote.updatedAt,
    items: items.map(buildQuoteItemDto),
    ...(readiness === undefined ? {} : { readiness })
});

const ensureSelectedHandyman = (job, handymanId) => {
    if (job.selected_handyman_id !== handymanId) {
        return serviceError(
            'Only the selected handyman can manage the inspection quote.',
            403,
            'NOT_SELECTED_HANDYMAN'
        );
    }
    return null;
};

const validateQuoteContext = (job, quote) => {
    if (quote.job_id !== job.id
        || Number(quote.acceptance_cycle) !== Number(job.acceptance_cycle)
        || quote.customer_id !== job.customer_id
        || quote.handyman_id !== job.selected_handyman_id
        || quote.selected_bid_id !== job.selected_bid_id) {
        return serviceError(
            'Quote acceptance context is inconsistent.',
            409,
            'ACCEPTANCE_CYCLE_INCONSISTENT'
        );
    }
    return null;
};

const validateWritableArrivedJob = async (job, handymanId, transaction) => {
    const selectedError = ensureSelectedHandyman(job, handymanId);
    if (selectedError) return { error: selectedError };
    if (job.current_status !== 'ARRIVED') {
        return {
            error: serviceError(
                'Job must be ARRIVED to manage a quote draft.',
                409,
                'JOB_NOT_ARRIVED',
                { current_status: job.current_status }
            )
        };
    }

    const invariant = await validateAcceptedJobInvariants(job, { transaction });
    if (invariant.error) return invariant;
    if (!invariant.customer.is_active || !invariant.selectedHandyman.is_active) {
        return {
            error: serviceError(
                'Customer and selected handyman must both be active.',
                409,
                'PARTICIPANT_INACTIVE'
            )
        };
    }
    const bidReference = parsePositiveBidReference(invariant.selectedBid.proposed_price);
    if (!bidReference.valid) {
        return {
            error: serviceError(
                bidReference.message,
                409,
                bidReference.code,
                ''
            )
        };
    }
    return { ...invariant, bidReference };
};

const findQuoteItems = (quoteId, options = {}) => JobQuoteItem.findAll({
    where: { quote_id: quoteId },
    order: [['sort_order', 'ASC']],
    ...options
});

const createOrGetQuoteDraftService = async (jobId, handymanId) => {
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
            await transaction.rollback();
            return serviceError('Job not found.', 404, 'JOB_NOT_FOUND');
        }
        const selectedError = ensureSelectedHandyman(job, handymanId);
        if (selectedError) {
            await transaction.rollback();
            return selectedError;
        }

        const existingQuote = await JobQuote.findOne({
            where: {
                job_id: job.id,
                acceptance_cycle: job.acceptance_cycle,
                version: 1
            },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (existingQuote) {
            const contextError = validateQuoteContext(job, existingQuote);
            if (contextError) {
                await transaction.rollback();
                return contextError;
            }
            const items = await findQuoteItems(existingQuote.id, { transaction });
            if (existingQuote.status === 'DRAFT' && job.current_status === 'ARRIVED') {
                const validation = await validateWritableArrivedJob(job, handymanId, transaction);
                if (validation.error) {
                    await transaction.rollback();
                    return validation.error;
                }
                await transaction.rollback();
                return {
                    EM: 'Quote draft already exists.',
                    EC: 0,
                    code: 'QUOTE_DRAFT_EXISTS',
                    DT: { quote: buildQuoteDto(existingQuote, items, { includeDraftRevision: true }) }
                };
            }
            if (existingQuote.status === 'SUBMITTED' && job.current_status === 'QUOTE_PENDING') {
                await transaction.rollback();
                return {
                    EM: 'Quote was already submitted.',
                    EC: 0,
                    code: 'QUOTE_ALREADY_SUBMITTED',
                    DT: { quote: buildQuoteDto(existingQuote, items, { includeDraftRevision: true }) }
                };
            }
            await transaction.rollback();
            return serviceError(
                'Existing quote does not match the current Job lifecycle.',
                409,
                'QUOTE_LIFECYCLE_INCONSISTENT'
            );
        }

        const validation = await validateWritableArrivedJob(job, handymanId, transaction);
        if (validation.error) {
            await transaction.rollback();
            return validation.error;
        }

        const quote = await JobQuote.create({
            job_id: job.id,
            acceptance_cycle: job.acceptance_cycle,
            customer_id: job.customer_id,
            handyman_id: job.selected_handyman_id,
            selected_bid_id: job.selected_bid_id,
            version: 1,
            draft_revision: 0,
            status: 'DRAFT',
            subtotal_amount: 0,
            discount_amount: 0,
            total_amount: 0,
            currency: 'VND',
            bid_reference_amount: validation.bidReference.value,
            variance_amount: `-${validation.bidReference.value}`,
            variance_percent: '-100.0000'
        }, { transaction });

        await transaction.commit();
        return {
            EM: 'Quote draft created successfully.',
            EC: 0,
            code: 'QUOTE_DRAFT_CREATED',
            DT: { quote: buildQuoteDto(quote, [], { includeDraftRevision: true }) }
        };
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('>>> Error in createOrGetQuoteDraftService:', error?.message || 'Unknown error');
        return serviceError('Unable to create quote draft.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const updateQuoteDraftService = async (jobId, quoteId, handymanId, payload) => {
    if (!isValidUuid(jobId) || !isValidUuid(quoteId)) {
        return serviceError('Invalid job or quote id.', 400, 'VALIDATION_ERROR');
    }

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
        const validation = await validateWritableArrivedJob(job, handymanId, transaction);
        if (validation.error) {
            await transaction.rollback();
            return validation.error;
        }

        const quote = await JobQuote.findOne({
            where: { id: quoteId, job_id: job.id },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!quote) {
            await transaction.rollback();
            return serviceError('Quote not found.', 404, 'QUOTE_NOT_FOUND');
        }
        const contextError = validateQuoteContext(job, quote);
        if (contextError) {
            await transaction.rollback();
            return contextError;
        }
        if (quote.status !== 'DRAFT') {
            await transaction.rollback();
            return serviceError('Submitted quotes are locked.', 409, 'QUOTE_NOT_DRAFT');
        }

        const normalized = validateDraftPayload(payload, {
            bidReferenceAmount: validation.selectedBid.proposed_price
        });
        if (!normalized.valid) {
            await transaction.rollback();
            const status = normalized.code === 'ACCEPTED_DATA_INCONSISTENT' ? 409 : 400;
            return serviceError(normalized.message, status, normalized.code);
        }
        if (normalized.expectedDraftRevision !== Number(quote.draft_revision)) {
            await transaction.rollback();
            return serviceError(
                'Quote draft was updated by another request.',
                409,
                'QUOTE_DRAFT_REVISION_CONFLICT',
                { current_draft_revision: Number(quote.draft_revision) }
            );
        }

        await JobQuoteItem.destroy({
            where: { quote_id: quote.id },
            transaction
        });
        const createdItems = normalized.items.length > 0
            ? await JobQuoteItem.bulkCreate(
                normalized.items.map((item) => ({ ...item, quote_id: quote.id })),
                { transaction, returning: true }
            )
            : [];
        await quote.update({
            ...normalized.data,
            draft_revision: Number(quote.draft_revision) + 1
        }, { transaction });

        const evidenceCount = await EvidenceVault.count({
            where: {
                job_id: job.id,
                acceptance_cycle: job.acceptance_cycle,
                customer_id: job.customer_id,
                handyman_id: job.selected_handyman_id,
                selected_bid_id: job.selected_bid_id,
                uploader_id: job.selected_handyman_id,
                stage: 'BEFORE',
                media_type: 'IMAGE'
            },
            transaction
        });
        const readiness = buildSubmitReadiness({ normalized, evidenceCount });
        await transaction.commit();

        return {
            EM: 'Quote draft updated successfully.',
            EC: 0,
            code: 'QUOTE_DRAFT_UPDATED',
            DT: {
                quote: buildQuoteDto(quote, createdItems, {
                    includeDraftRevision: true,
                    readiness
                })
            }
        };
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('>>> Error in updateQuoteDraftService:', error?.message || 'Unknown error');
        return serviceError('Unable to update quote draft.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const getReadinessError = (readiness) => {
    const code = readiness.missing_requirements[0] || 'QUOTE_NOT_READY';
    const messages = {
        BEFORE_EVIDENCE_REQUIRED: 'At least one BEFORE evidence image is required.',
        PROBLEM_SUMMARY_REQUIRED: 'problem_summary is required before submitting.',
        RECOMMENDED_SOLUTION_REQUIRED: 'recommended_solution is required before submitting.',
        ESTIMATED_DURATION_REQUIRED: 'estimated_duration_minutes is required before submitting.',
        WARRANTY_DAYS_REQUIRED: 'warranty_days is required before submitting.',
        QUOTE_ITEMS_REQUIRED: 'At least one quote item is required.',
        INVALID_QUOTE_AMOUNT: 'Quote total must be greater than zero.',
        VARIANCE_REASON_REQUIRED: 'A variance reason is required for this quote.',
        VARIANCE_REASON_TEXT_REQUIRED: 'variance_reason_text is required when reason is OTHER.'
    };
    return serviceError(messages[code] || 'Quote is not ready to submit.', 409, code, {
        readiness
    });
};

const submitQuoteService = async (jobId, quoteId, handymanId, payload = {}) => {
    if (!isValidUuid(jobId) || !isValidUuid(quoteId)) {
        return serviceError('Invalid job or quote id.', 400, 'VALIDATION_ERROR');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.keys(payload).length > 0) {
        return serviceError('Submit Quote body must be an empty JSON object.', 400, 'VALIDATION_ERROR');
    }

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
        const selectedError = ensureSelectedHandyman(job, handymanId);
        if (selectedError) {
            await transaction.rollback();
            return selectedError;
        }

        const quote = await JobQuote.findOne({
            where: { id: quoteId, job_id: job.id },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!quote) {
            await transaction.rollback();
            return serviceError('Quote not found.', 404, 'QUOTE_NOT_FOUND');
        }
        const contextError = validateQuoteContext(job, quote);
        if (contextError) {
            await transaction.rollback();
            return contextError;
        }

        const items = await findQuoteItems(quote.id, {
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (quote.status === 'SUBMITTED' && job.current_status === 'QUOTE_PENDING') {
            await transaction.rollback();
            return {
                EM: 'Quote was already submitted.',
                EC: 0,
                code: 'QUOTE_ALREADY_SUBMITTED',
                DT: { quote: buildQuoteDto(quote, items, { includeDraftRevision: true }) }
            };
        }
        if (job.current_status !== 'ARRIVED') {
            await transaction.rollback();
            return serviceError(
                'Job must be ARRIVED before submitting a quote.',
                409,
                'JOB_NOT_ARRIVED',
                { current_status: job.current_status }
            );
        }
        if (quote.status !== 'DRAFT') {
            await transaction.rollback();
            return serviceError('Quote is not a Draft.', 409, 'QUOTE_NOT_DRAFT');
        }

        const invariant = await validateAcceptedJobInvariants(job, { transaction });
        if (invariant.error) {
            await transaction.rollback();
            return invariant.error;
        }
        if (!invariant.customer.is_active || !invariant.selectedHandyman.is_active) {
            await transaction.rollback();
            return serviceError(
                'Customer and selected handyman must both be active.',
                409,
                'PARTICIPANT_INACTIVE'
            );
        }
        const normalized = normalizeStoredQuote(quote, items, invariant.selectedBid.proposed_price);
        if (!normalized.valid) {
            await transaction.rollback();
            return serviceError(normalized.message, 409, normalized.code);
        }

        const evidence = await EvidenceVault.findAll({
            where: {
                job_id: job.id,
                acceptance_cycle: job.acceptance_cycle,
                customer_id: job.customer_id,
                handyman_id: job.selected_handyman_id,
                selected_bid_id: job.selected_bid_id,
                uploader_id: job.selected_handyman_id,
                stage: 'BEFORE',
                media_type: 'IMAGE'
            },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        const config = getQuoteConfig();
        if (evidence.length > config.beforeEvidenceMaxFiles) {
            await transaction.rollback();
            return serviceError(
                'The current acceptance cycle has too many BEFORE evidence images.',
                409,
                'BEFORE_EVIDENCE_LIMIT_REACHED'
            );
        }
        const readiness = buildSubmitReadiness({
            normalized,
            evidenceCount: evidence.length
        });
        if (!readiness.ready) {
            await transaction.rollback();
            return getReadinessError(readiness);
        }

        for (let index = 0; index < items.length; index += 1) {
            const canonicalItem = normalized.items[index];
            await items[index].update({
                description: canonicalItem.description,
                quantity: canonicalItem.quantity,
                unit: canonicalItem.unit,
                unit_price: canonicalItem.unit_price,
                line_total: canonicalItem.line_total,
                sort_order: canonicalItem.sort_order
            }, { transaction });
        }

        const submittedAt = new Date();
        await quote.update({
            ...normalized.data,
            status: 'SUBMITTED',
            submitted_at: submittedAt
        }, { transaction });
        await job.update({ current_status: 'QUOTE_PENDING' }, { transaction });
        await JobStatusHistory.create({
            job_id: job.id,
            changed_by_user_id: handymanId,
            old_status: 'ARRIVED',
            new_status: 'QUOTE_PENDING',
            reason: `HANDYMAN_SUBMITTED_QUOTE:${quote.id}`
        }, { transaction });

        await transaction.commit();
        emitJobLifecycleEvent({
            event: JOB_LIFECYCLE_EVENTS.QUOTE_SUBMITTED,
            userIds: [job.customer_id, job.selected_handyman_id],
            payload: {
                job_id: job.id,
                acceptance_cycle: Number(job.acceptance_cycle),
                status: 'QUOTE_PENDING',
                quote_id: quote.id,
                version: Number(quote.version),
                total_amount: toCanonicalMoneyString(quote.total_amount),
                submitted_at: submittedAt
            }
        });

        return {
            EM: 'Quote submitted successfully.',
            EC: 0,
            code: 'QUOTE_SUBMITTED',
            DT: { quote: buildQuoteDto(quote, items, { includeDraftRevision: true }) }
        };
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('>>> Error in submitQuoteService:', error?.message || 'Unknown error');
        return serviceError('Unable to submit quote.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const getCurrentQuoteService = async (jobId, currentUser) => {
    if (!isValidUuid(jobId)) {
        return serviceError('Invalid job id.', 400, 'VALIDATION_ERROR');
    }
    try {
        const job = await Job.findByPk(jobId);
        if (!job) return serviceError('Job not found.', 404, 'JOB_NOT_FOUND');

        const isAdmin = currentUser.role === 'ADMIN';
        const isCustomer = currentUser.role === 'CUSTOMER' && job.customer_id === currentUser.id;
        const isSelectedHandyman = currentUser.role === 'HANDYMAN'
            && job.selected_handyman_id === currentUser.id;
        if (!isAdmin && !isCustomer && !isSelectedHandyman) {
            return serviceError('Quote not found.', 404, 'QUOTE_NOT_FOUND');
        }

        const quote = await JobQuote.findOne({
            where: {
                job_id: job.id,
                acceptance_cycle: job.acceptance_cycle,
                version: 1
            }
        });
        const customerVisibleStatuses = ['SUBMITTED', 'ACCEPTED', 'REJECTED'];
        if (!quote || (isCustomer && !customerVisibleStatuses.includes(quote.status))) {
            return serviceError('Quote not found.', 404, 'QUOTE_NOT_FOUND');
        }
        const contextError = validateQuoteContext(job, quote);
        if (contextError) return contextError;
        const items = await findQuoteItems(quote.id);

        return {
            EM: 'Current quote retrieved successfully.',
            EC: 0,
            code: 'CURRENT_QUOTE_RETRIEVED',
            DT: {
                quote: buildQuoteDto(quote, items, {
                    includeDraftRevision: isAdmin || isSelectedHandyman
                })
            }
        };
    } catch (error) {
        console.error('>>> Error in getCurrentQuoteService:', error?.message || 'Unknown error');
        return serviceError('Unable to retrieve current quote.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

export {
    buildQuoteDto,
    createOrGetQuoteDraftService,
    findQuoteItems,
    getCurrentQuoteService,
    submitQuoteService,
    updateQuoteDraftService,
    validateQuoteContext
};
