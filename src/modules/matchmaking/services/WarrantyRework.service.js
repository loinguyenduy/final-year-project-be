import { Op } from 'sequelize';
import { randomUUID } from 'node:crypto';
import db from '../../../core/database/connection.js';
import { emitToRole } from '../../../core/realtime/realtime.gateway.js';
import { CONVERSATION_CLOSED_REASONS } from '../../chat/constants/chat.constants.js';
import Conversation from '../../chat/models/Conversation.model.js';
import { closeConversationRecord } from '../../chat/services/ConversationLifecycle.service.js';
import EContract from '../../fintech/models/EContract.model.js';
import EvidenceVault from '../../fintech/models/EvidenceVault.model.js';
import {
    releaseWarrantyReserveInTransaction
} from '../../fintech/services/WarrantySettlement.service.js';
import Job from '../models/Job.model.js';
import JobStatusHistory from '../models/JobStatusHistory.model.js';
import JobWarranty from '../models/JobWarranty.model.js';
import WarrantyClaim from '../models/WarrantyClaim.model.js';
import WarrantyCompletionRequest from '../models/WarrantyCompletionRequest.model.js';
import WarrantyCompletionRequestEvidence from '../models/WarrantyCompletionRequestEvidence.model.js';
import {
    JOB_LIFECYCLE_EVENTS,
    emitJobLifecycleEvent
} from '../sockets/JobLifecycle.gateway.js';
import { buildEvidenceDto } from '../utils/evidence.util.js';
import { isValidUuid, serviceError } from './AcceptedJob.service.js';
import { validateRejectPayload } from './CompletionRequest.service.js';
import { evidenceWhere } from './WorkEvidence.service.js';

const rollbackWith = async (transaction, result) => {
    if (!transaction.finished) await transaction.rollback();
    return result;
};

const validateCreatePayload = (payload = {}) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { valid: false, message: 'Warranty Completion Request body must be an object.' };
    }
    const unknown = Object.keys(payload).filter((field) => field !== 'completion_note');
    if (unknown.length > 0) return { valid: false, message: `Unsupported fields: ${unknown.join(', ')}.` };
    if (payload.completion_note !== undefined
        && payload.completion_note !== null
        && typeof payload.completion_note !== 'string') {
        return { valid: false, message: 'completion_note must be plain text.' };
    }
    const note = typeof payload.completion_note === 'string'
        ? payload.completion_note.trim()
        : null;
    if (note && note.length > 2000) {
        return { valid: false, message: 'completion_note must not exceed 2000 characters.' };
    }
    return { valid: true, completionNote: note || null };
};

const buildWarrantyCompletionRequestDto = (request) => request ? ({
    id: request.id,
    job_id: request.job_id,
    warranty_id: request.warranty_id,
    claim_id: request.claim_id,
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

const createWarrantyCompletionRequestService = async (jobId, handymanId, payload = {}) => {
    if (!isValidUuid(jobId)) return serviceError('Invalid Job id.', 400, 'VALIDATION_ERROR');
    const body = validateCreatePayload(payload);
    if (!body.valid) return serviceError(body.message, 400, 'VALIDATION_ERROR');
    const transaction = await db.transaction();
    try {
        const job = await Job.findByPk(jobId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!job) return rollbackWith(transaction, serviceError('Job not found.', 404, 'JOB_NOT_FOUND'));
        if (job.selected_handyman_id !== handymanId) {
            return rollbackWith(transaction, serviceError('Only the selected handyman can request Warranty completion.', 403, 'NOT_SELECTED_HANDYMAN'));
        }
        if (job.current_status !== 'WARRANTY') {
            return rollbackWith(transaction, serviceError('Job is not in WARRANTY.', 409, 'JOB_NOT_IN_WARRANTY'));
        }
        const warranty = await JobWarranty.findOne({
            where: { job_id: job.id, acceptance_cycle: job.acceptance_cycle },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!warranty || warranty.status !== 'REWORK_REQUIRED') {
            return rollbackWith(transaction, serviceError('Warranty rework is not required.', 409, 'WARRANTY_REWORK_NOT_REQUIRED'));
        }
        const claim = await WarrantyClaim.findOne({
            where: { warranty_id: warranty.id, status: 'APPROVED_REWORK_REQUIRED' },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!claim) {
            return rollbackWith(transaction, serviceError(
                'The Warranty and Claim approval states are inconsistent.',
                409,
                'WARRANTY_STATE_INCONSISTENT'
            ));
        }
        const pending = await WarrantyCompletionRequest.findOne({
            where: { warranty_id: warranty.id, status: 'PENDING' },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (pending) {
            await transaction.commit();
            return {
                EM: 'A Warranty Completion Request is already pending.',
                EC: 0,
                code: 'WARRANTY_COMPLETION_REQUEST_ALREADY_PENDING',
                DT: { request: buildWarrantyCompletionRequestDto(pending) }
            };
        }
        const evidence = await EvidenceVault.findAll({
            where: evidenceWhere(job, 'WARRANTY', { uploader_id: job.selected_handyman_id }),
            transaction,
            lock: transaction.LOCK.UPDATE,
            order: [['uploaded_at', 'ASC']]
        });
        const existingLinks = evidence.length === 0 ? [] : await WarrantyCompletionRequestEvidence.findAll({
            where: { evidence_id: { [Op.in]: evidence.map((item) => item.id) } },
            attributes: ['evidence_id'],
            transaction
        });
        const linkedIds = new Set(existingLinks.map((link) => link.evidence_id));
        const availableEvidence = evidence.filter((item) => !linkedIds.has(item.id));
        if (availableEvidence.length < 1) {
            return rollbackWith(transaction, serviceError('At least one Warranty Evidence image is required.', 409, 'WARRANTY_EVIDENCE_REQUIRED'));
        }
        const requestCount = await WarrantyCompletionRequest.count({
            where: { warranty_id: warranty.id },
            transaction
        });
        if (requestCount >= 2) {
            return rollbackWith(transaction, serviceError(
                'The maximum of two Warranty rework cycles has been reached.',
                409,
                'REWORK_CYCLE_LIMIT_REACHED'
            ));
        }
        const requestedAt = new Date();
        const request = await WarrantyCompletionRequest.create({
            job_id: job.id,
            acceptance_cycle: job.acceptance_cycle,
            warranty_id: warranty.id,
            claim_id: claim.id,
            customer_id: job.customer_id,
            handyman_id: job.selected_handyman_id,
            status: 'PENDING',
            request_sequence: requestCount + 1,
            completion_note: body.completionNote,
            requested_at: requestedAt
        }, { transaction });
        await WarrantyCompletionRequestEvidence.bulkCreate(
            availableEvidence.map((item) => ({
                warranty_completion_request_id: request.id,
                evidence_id: item.id,
                snapshotted_at: requestedAt
            })),
            { transaction }
        );
        await warranty.update({ status: 'REWORK_CONFIRMATION_PENDING' }, { transaction });
        await transaction.commit();

        emitJobLifecycleEvent({
            event: JOB_LIFECYCLE_EVENTS.WARRANTY_COMPLETION_REQUESTED,
            userIds: [job.customer_id, job.selected_handyman_id],
            payload: {
                job_id: job.id,
                acceptance_cycle: Number(job.acceptance_cycle),
                warranty_id: warranty.id,
                claim_id: claim.id,
                warranty_completion_request_id: request.id,
                request_sequence: Number(request.request_sequence),
                warranty_status: 'REWORK_CONFIRMATION_PENDING',
                occurred_at: requestedAt
            }
        });
        return {
            EM: 'Warranty Completion Request created successfully.',
            EC: 0,
            code: 'WARRANTY_COMPLETION_REQUEST_CREATED',
            DT: { request: buildWarrantyCompletionRequestDto(request) }
        };
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('[warranty] Create rework request failed.', { job_id: jobId, error: error?.message });
        return serviceError('Unable to create Warranty Completion Request.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const confirmWarrantyCompletionRequestService = async (jobId, requestId, currentUser) => {
    if (!isValidUuid(jobId) || !isValidUuid(requestId)) {
        return serviceError('Invalid Job or Warranty Completion Request id.', 400, 'VALIDATION_ERROR');
    }
    const transaction = await db.transaction();
    try {
        const job = await Job.findByPk(jobId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!job) return rollbackWith(transaction, serviceError('Job not found.', 404, 'JOB_NOT_FOUND'));
        if (currentUser?.role !== 'CUSTOMER' || job.customer_id !== currentUser.id) {
            return rollbackWith(transaction, serviceError('Only the Job Customer can confirm Warranty completion.', 403, 'NOT_JOB_CUSTOMER'));
        }
        const request = await WarrantyCompletionRequest.findOne({
            where: { id: requestId, job_id: job.id, acceptance_cycle: job.acceptance_cycle },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!request) return rollbackWith(transaction, serviceError('Warranty Completion Request not found.', 404, 'WARRANTY_COMPLETION_REQUEST_NOT_FOUND'));
        const warranty = await JobWarranty.findByPk(request.warranty_id, { transaction, lock: transaction.LOCK.UPDATE });
        const claim = await WarrantyClaim.findByPk(request.claim_id, { transaction, lock: transaction.LOCK.UPDATE });
        if (request.status === 'CONFIRMED') {
            if (!warranty || !claim || warranty.status !== 'COMPLETED'
                || claim.status !== 'RESOLVED' || job.current_status !== 'CLOSED'
                || !warranty.released_at) {
                return rollbackWith(transaction, serviceError('Warranty settlement state is inconsistent.', 409, 'FINANCIAL_DATA_INCONSISTENT'));
            }
            await transaction.commit();
            return {
                EM: 'Warranty completion was already confirmed.',
                EC: 0,
                code: 'WARRANTY_COMPLETION_ALREADY_CONFIRMED',
                DT: { request: buildWarrantyCompletionRequestDto(request), current_status: 'CLOSED' }
            };
        }
        if (request.status !== 'PENDING') {
            return rollbackWith(transaction, serviceError('Warranty Completion Request is not pending.', 409, 'WARRANTY_COMPLETION_REQUEST_NOT_PENDING'));
        }
        if (!warranty || !claim
            || job.current_status !== 'WARRANTY'
            || warranty.status !== 'REWORK_CONFIRMATION_PENDING'
            || claim.status !== 'APPROVED_REWORK_REQUIRED') {
            return rollbackWith(transaction, serviceError('Warranty rework lifecycle is inconsistent.', 409, 'WARRANTY_REWORK_NOT_REQUIRED'));
        }
        const contract = await EContract.findOne({
            where: { id: warranty.contract_id, job_id: job.id },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!contract || contract.status !== 'ACTIVE') {
            return rollbackWith(transaction, serviceError('Active Contract not found.', 409, 'FINANCIAL_DATA_INCONSISTENT'));
        }
        const release = await releaseWarrantyReserveInTransaction({
            job,
            warranty,
            transaction,
            warrantyCompletionRequestId: request.id
        });
        if (release.error) return rollbackWith(transaction, release.error);

        const respondedAt = new Date();
        await request.update({
            status: 'CONFIRMED',
            responded_at: respondedAt,
            responded_by_user_id: currentUser.id,
            rejection_reason: null,
            rejection_note: null
        }, { transaction });
        await claim.update({ status: 'RESOLVED', resolved_at: respondedAt }, { transaction });
        await warranty.update({
            status: 'COMPLETED',
            warranty_released_amount: release.releasedAmount.toString(),
            released_at: respondedAt,
            release_transaction_id: release.releaseTransaction.id
        }, { transaction });
        await job.update({ current_status: 'CLOSED' }, { transaction });
        await contract.update({ status: 'COMPLETED' }, { transaction });
        await JobStatusHistory.create({
            job_id: job.id,
            changed_by_user_id: currentUser.id,
            old_status: 'WARRANTY',
            new_status: 'CLOSED',
            reason: `CUSTOMER_CONFIRMED_WARRANTY_REWORK:${request.id}`
        }, { transaction });
        const conversation = await Conversation.findOne({
            where: { job_id: job.id, acceptance_cycle: job.acceptance_cycle },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (conversation) {
            await closeConversationRecord(conversation, {
                reason: CONVERSATION_CLOSED_REASONS.JOB_CLOSED,
                closedByUserId: currentUser.id,
                transaction
            });
        }
        await transaction.commit();

        const eventPayload = {
            job_id: job.id,
            acceptance_cycle: Number(job.acceptance_cycle),
            warranty_id: warranty.id,
            claim_id: claim.id,
            warranty_completion_request_id: request.id,
            current_status: 'CLOSED',
            warranty_status: 'COMPLETED',
            occurred_at: respondedAt
        };
        emitJobLifecycleEvent({
            event: JOB_LIFECYCLE_EVENTS.WARRANTY_REWORK_CONFIRMED,
            userIds: [job.customer_id, job.selected_handyman_id],
            payload: eventPayload
        });
        emitJobLifecycleEvent({
            event: JOB_LIFECYCLE_EVENTS.COMPLETED,
            userIds: [job.customer_id, job.selected_handyman_id],
            payload: eventPayload
        });
        return {
            EM: 'Warranty rework confirmed and Job closed successfully.',
            EC: 0,
            code: 'WARRANTY_REWORK_CONFIRMED',
            DT: { request: buildWarrantyCompletionRequestDto(request), current_status: 'CLOSED' }
        };
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('[warranty] Confirm rework failed.', { job_id: jobId, request_id: requestId, error: error?.message });
        return serviceError('Unable to confirm Warranty completion.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const rejectWarrantyCompletionRequestService = async (jobId, requestId, currentUser, payload = {}) => {
    if (!isValidUuid(jobId) || !isValidUuid(requestId)) {
        return serviceError('Invalid Job or Warranty Completion Request id.', 400, 'VALIDATION_ERROR');
    }
    const body = validateRejectPayload(payload);
    if (!body.valid) return serviceError(body.message, 400, 'VALIDATION_ERROR');
    const transaction = await db.transaction();
    try {
        const job = await Job.findByPk(jobId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!job) return rollbackWith(transaction, serviceError('Job not found.', 404, 'JOB_NOT_FOUND'));
        if (currentUser?.role !== 'CUSTOMER' || job.customer_id !== currentUser.id) {
            return rollbackWith(transaction, serviceError('Only the Job Customer can reject Warranty completion.', 403, 'NOT_JOB_CUSTOMER'));
        }
        const request = await WarrantyCompletionRequest.findOne({
            where: { id: requestId, job_id: job.id, acceptance_cycle: job.acceptance_cycle },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!request) return rollbackWith(transaction, serviceError('Warranty Completion Request not found.', 404, 'WARRANTY_COMPLETION_REQUEST_NOT_FOUND'));
        const warranty = await JobWarranty.findByPk(request.warranty_id, { transaction, lock: transaction.LOCK.UPDATE });
        const claim = await WarrantyClaim.findByPk(request.claim_id, { transaction, lock: transaction.LOCK.UPDATE });
        if (request.status === 'REJECTED') {
            const sameResponse = request.rejection_reason === body.reason
                && (request.rejection_note || null) === body.note;
            if (!sameResponse) {
                return rollbackWith(transaction, serviceError('Warranty Completion Request already has a different response.', 409, 'WARRANTY_COMPLETION_RESPONSE_CONFLICT'));
            }
            await transaction.commit();
            return {
                EM: 'Warranty Completion Request was already rejected.',
                EC: 0,
                code: 'WARRANTY_COMPLETION_ALREADY_REJECTED',
                DT: { request: buildWarrantyCompletionRequestDto(request) }
            };
        }
        if (request.status !== 'PENDING') {
            return rollbackWith(transaction, serviceError('Warranty Completion Request is not pending.', 409, 'WARRANTY_COMPLETION_REQUEST_NOT_PENDING'));
        }
        if (!warranty || !claim || job.current_status !== 'WARRANTY'
            || warranty.status !== 'REWORK_CONFIRMATION_PENDING'
            || claim.status !== 'APPROVED_REWORK_REQUIRED') {
            return rollbackWith(transaction, serviceError('Warranty rework lifecycle is inconsistent.', 409, 'WARRANTY_REWORK_NOT_REQUIRED'));
        }
        const respondedAt = new Date();
        await request.update({
            status: 'REJECTED',
            responded_at: respondedAt,
            responded_by_user_id: currentUser.id,
            rejection_reason: body.reason,
            rejection_note: body.note
        }, { transaction });
        await claim.update({ status: 'REVIEW_REQUIRED' }, { transaction });
        await warranty.update({ status: 'REVIEW_REQUIRED' }, { transaction });
        await transaction.commit();

        emitToRole('ADMIN', 'ADMIN_REVIEW_QUEUE_UPDATED', {
            event_id: randomUUID(),
            occurred_at: respondedAt.toISOString(),
            queue: 'ADMIN_REVIEW'
        });

        emitJobLifecycleEvent({
            event: JOB_LIFECYCLE_EVENTS.WARRANTY_REWORK_REJECTED,
            userIds: [job.customer_id, job.selected_handyman_id],
            payload: {
                job_id: job.id,
                acceptance_cycle: Number(job.acceptance_cycle),
                warranty_id: warranty.id,
                claim_id: claim.id,
                warranty_completion_request_id: request.id,
                current_status: 'WARRANTY',
                warranty_status: 'REVIEW_REQUIRED',
                occurred_at: respondedAt
            }
        });
        return {
            EM: 'Warranty Completion Request rejected for Admin review.',
            EC: 0,
            code: 'WARRANTY_REWORK_REJECTED',
            DT: { request: buildWarrantyCompletionRequestDto(request) }
        };
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('[warranty] Reject rework failed.', { job_id: jobId, request_id: requestId, error: error?.message });
        return serviceError('Unable to reject Warranty completion.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const canReadWarranty = (job, user) => user?.role === 'ADMIN'
    || (user?.role === 'CUSTOMER' && job.customer_id === user.id)
    || (user?.role === 'HANDYMAN' && job.selected_handyman_id === user.id);

const listWarrantyCompletionRequestsService = async (jobId, currentUser) => {
    if (!isValidUuid(jobId)) return serviceError('Invalid Job id.', 400, 'VALIDATION_ERROR');
    try {
        const job = await Job.findByPk(jobId);
        if (!job || !canReadWarranty(job, currentUser)) {
            return serviceError('Warranty Completion Requests not found.', 404, 'WARRANTY_COMPLETION_REQUEST_NOT_FOUND');
        }
        const requests = await WarrantyCompletionRequest.findAll({
            where: { job_id: job.id, acceptance_cycle: job.acceptance_cycle },
            order: [['request_sequence', 'DESC']]
        });
        return {
            EM: 'Warranty Completion Requests retrieved successfully.',
            EC: 0,
            code: 'WARRANTY_COMPLETION_REQUESTS_RETRIEVED',
            DT: { requests: requests.map(buildWarrantyCompletionRequestDto) }
        };
    } catch (error) {
        console.error('[warranty] List rework requests failed.', { job_id: jobId, error: error?.message });
        return serviceError('Unable to retrieve Warranty Completion Requests.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const getWarrantyCompletionEvidenceService = async (jobId, requestId, currentUser) => {
    if (!isValidUuid(jobId) || !isValidUuid(requestId)) {
        return serviceError('Invalid Job or Warranty Completion Request id.', 400, 'VALIDATION_ERROR');
    }
    try {
        const job = await Job.findByPk(jobId);
        const canReadEvidence = job && (
            currentUser?.role === 'ADMIN'
            || (currentUser?.role === 'HANDYMAN' && job.selected_handyman_id === currentUser.id)
        );
        if (!canReadEvidence) return serviceError('Evidence not found.', 404, 'EVIDENCE_NOT_FOUND');
        const request = await WarrantyCompletionRequest.findOne({
            where: { id: requestId, job_id: job.id, acceptance_cycle: job.acceptance_cycle }
        });
        if (!request) return serviceError('Evidence not found.', 404, 'EVIDENCE_NOT_FOUND');
        const links = await WarrantyCompletionRequestEvidence.findAll({
            where: { warranty_completion_request_id: request.id },
            attributes: ['evidence_id']
        });
        const evidence = links.length === 0 ? [] : await EvidenceVault.findAll({
            where: { id: { [Op.in]: links.map((link) => link.evidence_id) } },
            order: [['uploaded_at', 'ASC']]
        });
        return {
            EM: 'Warranty Completion Evidence retrieved successfully.',
            EC: 0,
            code: 'WARRANTY_COMPLETION_EVIDENCE_RETRIEVED',
            DT: {
                request: buildWarrantyCompletionRequestDto(request),
                evidence: evidence.map((item) => buildEvidenceDto(item, {
                    includeAudit: currentUser.role === 'ADMIN',
                    includeManagedState: true,
                    isLocked: true,
                    deletable: false
                }))
            }
        };
    } catch (error) {
        console.error('[warranty] Get rework Evidence failed.', { job_id: jobId, request_id: requestId, error: error?.message });
        return serviceError('Unable to retrieve Warranty Completion Evidence.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

export {
    buildWarrantyCompletionRequestDto,
    confirmWarrantyCompletionRequestService,
    createWarrantyCompletionRequestService,
    getWarrantyCompletionEvidenceService,
    listWarrantyCompletionRequestsService,
    rejectWarrantyCompletionRequestService
};
