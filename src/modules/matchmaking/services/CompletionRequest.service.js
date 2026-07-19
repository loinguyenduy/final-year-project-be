import { Op } from 'sequelize';
import db from '../../../core/database/connection.js';
import EvidenceVault from '../../fintech/models/EvidenceVault.model.js';
import {
    confirmCompletionSettlementService,
    loadCanonicalCompletionFinancialContext
} from '../../fintech/services/WarrantySettlement.service.js';
import Job from '../models/Job.model.js';
import JobCompletionRequest from '../models/JobCompletionRequest.model.js';
import JobCompletionRequestEvidence from '../models/JobCompletionRequestEvidence.model.js';
import {
    JOB_LIFECYCLE_EVENTS,
    emitJobLifecycleEvent
} from '../sockets/JobLifecycle.gateway.js';
import { buildEvidenceDto } from '../utils/evidence.util.js';
import { isValidUuid, serviceError } from './AcceptedJob.service.js';
import { evidenceWhere } from './WorkEvidence.service.js';

const COMPLETION_REJECTION_REASONS = Object.freeze([
    'WORK_NOT_COMPLETED',
    'RESULT_NOT_AS_AGREED',
    'FUNCTION_NOT_WORKING',
    'ADDITIONAL_DAMAGE_FOUND',
    'CLEANUP_NOT_COMPLETED',
    'OTHER'
]);

const rollbackWith = async (transaction, result) => {
    if (!transaction.finished) await transaction.rollback();
    return result;
};

const normalizeOptionalText = (value, field, maxLength) => {
    if (value === undefined || value === null || value === '') return { valid: true, value: null };
    if (typeof value !== 'string') return { valid: false, message: `${field} must be plain text.` };
    const normalized = value.trim();
    if (!normalized) return { valid: true, value: null };
    if (normalized.length > maxLength) {
        return { valid: false, message: `${field} must not exceed ${maxLength} characters.` };
    }
    return { valid: true, value: normalized };
};

const validateCreatePayload = (payload = {}) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { valid: false, message: 'Completion Request body must be an object.' };
    }
    const unknown = Object.keys(payload).filter((field) => field !== 'completion_note');
    if (unknown.length > 0) return { valid: false, message: `Unsupported fields: ${unknown.join(', ')}.` };
    const note = normalizeOptionalText(payload.completion_note, 'completion_note', 2000);
    return note.valid ? { valid: true, completionNote: note.value } : note;
};

const validateRejectPayload = (payload = {}) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { valid: false, message: 'Reject Completion body must be an object.' };
    }
    const unknown = Object.keys(payload).filter((field) => !['reason', 'note'].includes(field));
    if (unknown.length > 0) return { valid: false, message: `Unsupported fields: ${unknown.join(', ')}.` };
    if (!COMPLETION_REJECTION_REASONS.includes(payload.reason)) {
        return { valid: false, message: 'Completion rejection reason is invalid.' };
    }
    const note = normalizeOptionalText(payload.note, 'note', 500);
    if (!note.valid) return note;
    if (payload.reason === 'OTHER' && !note.value) {
        return { valid: false, message: 'note is required when reason is OTHER.' };
    }
    return { valid: true, reason: payload.reason, note: note.value };
};

const buildCompletionRequestDto = (request) => request ? ({
    id: request.id,
    job_id: request.job_id,
    acceptance_cycle: Number(request.acceptance_cycle),
    status: request.status,
    request_sequence: Number(request.request_sequence),
    completion_note: request.completion_note,
    requested_at: request.requested_at,
    responded_at: request.responded_at,
    rejection_reason: request.rejection_reason,
    rejection_note: request.rejection_note,
    created_at: request.createdAt,
    updated_at: request.updatedAt
}) : null;

const loadCompletionEvidence = (job, transaction = null, lock = false) => EvidenceVault.findAll({
    where: {
        ...evidenceWhere(job, 'DURING'),
        stage: { [Op.in]: ['DURING', 'AFTER'] },
        uploader_id: job.selected_handyman_id
    },
    order: [['uploaded_at', 'ASC'], ['id', 'ASC']],
    ...(transaction ? {
        transaction,
        ...(lock ? { lock: transaction.LOCK.UPDATE } : {})
    } : {})
});

const buildCompletionReadiness = async (job, options = {}) => {
    const evidence = await loadCompletionEvidence(job, options.transaction, false);
    const duringCount = evidence.filter((item) => item.stage === 'DURING').length;
    const afterCount = evidence.filter((item) => item.stage === 'AFTER').length;
    const requests = await JobCompletionRequest.findAll({
        where: { job_id: job.id, acceptance_cycle: job.acceptance_cycle },
        order: [['request_sequence', 'DESC']],
        ...(options.transaction ? { transaction: options.transaction } : {})
    });
    const latestRequest = requests[0] || null;
    const pendingRequest = requests.find((request) => request.status === 'PENDING') || null;
    let newEvidenceCount = evidence.length;
    if (requests.length > 0 && evidence.length > 0) {
        const linked = await JobCompletionRequestEvidence.findAll({
            where: { evidence_id: { [Op.in]: evidence.map((item) => item.id) } },
            attributes: ['evidence_id'],
            raw: true,
            ...(options.transaction ? { transaction: options.transaction } : {})
        });
        const linkedIds = new Set(linked.map((item) => item.evidence_id));
        newEvidenceCount = evidence.filter((item) => !linkedIds.has(item.id)).length;
    }
    const blockingReasons = [];
    if (duringCount < 1) blockingReasons.push('DURING_EVIDENCE_REQUIRED');
    if (afterCount < 1) blockingReasons.push('AFTER_EVIDENCE_REQUIRED');
    if (pendingRequest) blockingReasons.push('COMPLETION_REQUEST_ALREADY_PENDING');
    if (requests.length > 0 && !pendingRequest && newEvidenceCount < 1) {
        blockingReasons.push('NEW_COMPLETION_EVIDENCE_REQUIRED');
    }
    if (job.current_status !== 'IN_PROGRESS') blockingReasons.push('JOB_NOT_IN_PROGRESS');
    return {
        latestRequest,
        pendingRequest,
        requests,
        evidence,
        readiness: {
            during_evidence_required: true,
            after_evidence_required: true,
            during_evidence_count: duringCount,
            after_evidence_count: afterCount,
            new_evidence_count: newEvidenceCount,
            ready_to_request_completion: blockingReasons.length === 0,
            blocking_reasons: blockingReasons
        }
    };
};

const createCompletionRequestService = async (jobId, handymanId, payload = {}) => {
    if (!isValidUuid(jobId)) return serviceError('Invalid Job id.', 400, 'VALIDATION_ERROR');
    const body = validateCreatePayload(payload);
    if (!body.valid) return serviceError(body.message, 400, 'VALIDATION_ERROR');
    const transaction = await db.transaction();
    try {
        const job = await Job.findByPk(jobId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!job) return rollbackWith(transaction, serviceError('Job not found.', 404, 'JOB_NOT_FOUND'));
        if (job.selected_handyman_id !== handymanId) {
            return rollbackWith(transaction, serviceError('Only the selected handyman can request completion.', 403, 'NOT_SELECTED_HANDYMAN'));
        }
        if (job.current_status !== 'IN_PROGRESS') {
            return rollbackWith(transaction, serviceError('Job is not IN_PROGRESS.', 409, 'JOB_NOT_IN_PROGRESS'));
        }
        const pending = await JobCompletionRequest.findOne({
            where: { job_id: job.id, acceptance_cycle: job.acceptance_cycle, status: 'PENDING' },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (pending) {
            await transaction.commit();
            return {
                EM: 'A Completion Request is already pending.',
                EC: 0,
                code: 'COMPLETION_REQUEST_ALREADY_PENDING',
                DT: { request: buildCompletionRequestDto(pending) }
            };
        }
        const financial = await loadCanonicalCompletionFinancialContext(job, transaction);
        if (financial.error) return rollbackWith(transaction, financial.error);

        const evidence = await loadCompletionEvidence(job, transaction, true);
        if (!evidence.some((item) => item.stage === 'DURING')) {
            return rollbackWith(transaction, serviceError('At least one DURING Evidence is required.', 409, 'DURING_EVIDENCE_REQUIRED'));
        }
        if (!evidence.some((item) => item.stage === 'AFTER')) {
            return rollbackWith(transaction, serviceError('At least one AFTER Evidence is required.', 409, 'AFTER_EVIDENCE_REQUIRED'));
        }
        const priorRequests = await JobCompletionRequest.findAll({
            where: { job_id: job.id, acceptance_cycle: job.acceptance_cycle },
            order: [['request_sequence', 'DESC']],
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (priorRequests.length > 0) {
            const priorLinks = await JobCompletionRequestEvidence.findAll({
                where: { evidence_id: { [Op.in]: evidence.map((item) => item.id) } },
                attributes: ['evidence_id'],
                transaction
            });
            const priorIds = new Set(priorLinks.map((link) => link.evidence_id));
            if (!evidence.some((item) => !priorIds.has(item.id))) {
                return rollbackWith(transaction, serviceError(
                    'At least one new Evidence image is required after rejection.',
                    409,
                    'NEW_COMPLETION_EVIDENCE_REQUIRED'
                ));
            }
        }
        const sequence = priorRequests.length > 0
            ? Number(priorRequests[0].request_sequence) + 1
            : 1;
        const requestedAt = new Date();
        const request = await JobCompletionRequest.create({
            job_id: job.id,
            acceptance_cycle: job.acceptance_cycle,
            customer_id: job.customer_id,
            handyman_id: job.selected_handyman_id,
            status: 'PENDING',
            request_sequence: sequence,
            completion_note: body.completionNote,
            requested_at: requestedAt
        }, { transaction });
        await JobCompletionRequestEvidence.bulkCreate(
            evidence.map((item) => ({
                completion_request_id: request.id,
                evidence_id: item.id,
                snapshotted_at: requestedAt
            })),
            { transaction }
        );
        await transaction.commit();

        emitJobLifecycleEvent({
            event: JOB_LIFECYCLE_EVENTS.COMPLETION_REQUESTED,
            userIds: [job.customer_id, job.selected_handyman_id],
            payload: {
                job_id: job.id,
                acceptance_cycle: Number(job.acceptance_cycle),
                completion_request_id: request.id,
                request_sequence: sequence,
                current_status: 'IN_PROGRESS',
                occurred_at: requestedAt
            }
        });
        return {
            EM: 'Completion Request created successfully.',
            EC: 0,
            code: 'COMPLETION_REQUEST_CREATED',
            DT: { request: buildCompletionRequestDto(request) }
        };
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('[matchmaking] Create Completion Request failed.', { job_id: jobId, error: error?.message });
        return serviceError('Unable to create Completion Request.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const rejectCompletionRequestService = async (jobId, requestId, currentUser, payload = {}) => {
    if (!isValidUuid(jobId) || !isValidUuid(requestId)) {
        return serviceError('Invalid Job or Completion Request id.', 400, 'VALIDATION_ERROR');
    }
    const body = validateRejectPayload(payload);
    if (!body.valid) return serviceError(body.message, 400, 'VALIDATION_ERROR');
    const transaction = await db.transaction();
    try {
        const job = await Job.findByPk(jobId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!job) return rollbackWith(transaction, serviceError('Job not found.', 404, 'JOB_NOT_FOUND'));
        if (currentUser?.role !== 'CUSTOMER' || job.customer_id !== currentUser.id) {
            return rollbackWith(transaction, serviceError('Only the Job Customer can reject completion.', 403, 'NOT_JOB_CUSTOMER'));
        }
        const request = await JobCompletionRequest.findOne({
            where: { id: requestId, job_id: job.id, acceptance_cycle: job.acceptance_cycle },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!request) return rollbackWith(transaction, serviceError('Completion Request not found.', 404, 'COMPLETION_REQUEST_NOT_FOUND'));
        if (request.status === 'REJECTED') {
            const sameResponse = request.rejection_reason === body.reason
                && (request.rejection_note || null) === body.note;
            if (!sameResponse) {
                return rollbackWith(transaction, serviceError('Completion Request already has a different response.', 409, 'COMPLETION_RESPONSE_CONFLICT'));
            }
            await transaction.commit();
            return {
                EM: 'Completion Request was already rejected.',
                EC: 0,
                code: 'COMPLETION_ALREADY_REJECTED',
                DT: { request: buildCompletionRequestDto(request) }
            };
        }
        if (request.status !== 'PENDING') {
            return rollbackWith(transaction, serviceError('Completion Request is not pending.', 409, 'COMPLETION_REQUEST_NOT_PENDING'));
        }
        if (job.current_status !== 'IN_PROGRESS') {
            return rollbackWith(transaction, serviceError('Job is not IN_PROGRESS.', 409, 'JOB_NOT_IN_PROGRESS'));
        }
        const respondedAt = new Date();
        await request.update({
            status: 'REJECTED',
            responded_at: respondedAt,
            responded_by_user_id: currentUser.id,
            rejection_reason: body.reason,
            rejection_note: body.note
        }, { transaction });
        await transaction.commit();
        emitJobLifecycleEvent({
            event: JOB_LIFECYCLE_EVENTS.COMPLETION_REJECTED,
            userIds: [job.customer_id, job.selected_handyman_id],
            payload: {
                job_id: job.id,
                acceptance_cycle: Number(job.acceptance_cycle),
                completion_request_id: request.id,
                request_sequence: Number(request.request_sequence),
                current_status: 'IN_PROGRESS',
                occurred_at: respondedAt
            }
        });
        return {
            EM: 'Completion Request rejected successfully.',
            EC: 0,
            code: 'COMPLETION_REJECTED',
            DT: { request: buildCompletionRequestDto(request) }
        };
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('[matchmaking] Reject Completion Request failed.', { job_id: jobId, request_id: requestId, error: error?.message });
        return serviceError('Unable to reject Completion Request.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const canReadJobLifecycle = (job, user) => user?.role === 'ADMIN'
    || (user?.role === 'CUSTOMER' && job.customer_id === user.id)
    || (user?.role === 'HANDYMAN' && job.selected_handyman_id === user.id);

const listCompletionRequestsService = async (jobId, currentUser) => {
    if (!isValidUuid(jobId)) return serviceError('Invalid Job id.', 400, 'VALIDATION_ERROR');
    try {
        const job = await Job.findByPk(jobId);
        if (!job || !canReadJobLifecycle(job, currentUser)) {
            return serviceError('Completion Requests not found.', 404, 'COMPLETION_REQUEST_NOT_FOUND');
        }
        const requests = await JobCompletionRequest.findAll({
            where: { job_id: job.id, acceptance_cycle: job.acceptance_cycle },
            order: [['request_sequence', 'DESC']]
        });
        return {
            EM: 'Completion Requests retrieved successfully.',
            EC: 0,
            code: 'COMPLETION_REQUESTS_RETRIEVED',
            DT: { requests: requests.map(buildCompletionRequestDto) }
        };
    } catch (error) {
        console.error('[matchmaking] List Completion Requests failed.', { job_id: jobId, error: error?.message });
        return serviceError('Unable to retrieve Completion Requests.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const getCompletionRequestEvidenceService = async (jobId, requestId, currentUser) => {
    if (!isValidUuid(jobId) || !isValidUuid(requestId)) {
        return serviceError('Invalid Job or Completion Request id.', 400, 'VALIDATION_ERROR');
    }
    try {
        const job = await Job.findByPk(jobId);
        const canReadEvidence = job && (
            currentUser?.role === 'ADMIN'
            || (currentUser?.role === 'HANDYMAN' && job.selected_handyman_id === currentUser.id)
        );
        if (!canReadEvidence) return serviceError('Evidence not found.', 404, 'EVIDENCE_NOT_FOUND');
        const request = await JobCompletionRequest.findOne({
            where: { id: requestId, job_id: job.id, acceptance_cycle: job.acceptance_cycle }
        });
        if (!request) return serviceError('Evidence not found.', 404, 'EVIDENCE_NOT_FOUND');
        const links = await JobCompletionRequestEvidence.findAll({
            where: { completion_request_id: request.id },
            attributes: ['evidence_id']
        });
        const evidence = links.length === 0 ? [] : await EvidenceVault.findAll({
            where: { id: { [Op.in]: links.map((link) => link.evidence_id) } },
            order: [['uploaded_at', 'ASC']]
        });
        return {
            EM: 'Completion Evidence snapshot retrieved successfully.',
            EC: 0,
            code: 'COMPLETION_EVIDENCE_RETRIEVED',
            DT: {
                request: buildCompletionRequestDto(request),
                evidence: evidence.map((item) => buildEvidenceDto(item, {
                    includeAudit: currentUser.role === 'ADMIN',
                    includeManagedState: true,
                    isLocked: true,
                    deletable: false
                }))
            }
        };
    } catch (error) {
        console.error('[matchmaking] Get Completion Evidence failed.', { job_id: jobId, request_id: requestId, error: error?.message });
        return serviceError('Unable to retrieve Completion Evidence.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

export {
    COMPLETION_REJECTION_REASONS,
    buildCompletionReadiness,
    buildCompletionRequestDto,
    confirmCompletionSettlementService,
    createCompletionRequestService,
    getCompletionRequestEvidenceService,
    listCompletionRequestsService,
    rejectCompletionRequestService,
    validateRejectPayload
};
