import { Op } from 'sequelize';
import db from '../../../core/database/connection.js';
import EvidenceVault from '../../fintech/models/EvidenceVault.model.js';
import Job from '../models/Job.model.js';
import JobWarranty from '../models/JobWarranty.model.js';
import WarrantyClaim from '../models/WarrantyClaim.model.js';
import WarrantyClaimEvidence from '../models/WarrantyClaimEvidence.model.js';
import {
    JOB_LIFECYCLE_EVENTS,
    emitJobLifecycleEvent
} from '../sockets/JobLifecycle.gateway.js';
import { buildEvidenceDto } from '../utils/evidence.util.js';
import { isValidUuid, serviceError } from './AcceptedJob.service.js';
import { ACTIVE_CLAIM_STATUSES, evidenceWhere } from './WorkEvidence.service.js';

const CLAIM_REASONS = Object.freeze([
    'ISSUE_RETURNED',
    'REPAIR_NOT_EFFECTIVE',
    'REPLACED_PART_FAILED',
    'RELATED_DAMAGE_FOUND',
    'WORK_NOT_AS_AGREED',
    'OTHER'
]);

const rollbackWith = async (transaction, result) => {
    if (!transaction.finished) await transaction.rollback();
    return result;
};

const validateClaimPayload = (payload = {}) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { valid: false, message: 'Warranty Claim body must be an object.' };
    }
    const unknown = Object.keys(payload).filter((field) => !['reason', 'description'].includes(field));
    if (unknown.length > 0) return { valid: false, message: `Unsupported fields: ${unknown.join(', ')}.` };
    if (!CLAIM_REASONS.includes(payload.reason)) {
        return { valid: false, message: 'Warranty Claim reason is invalid.' };
    }
    if (payload.description !== undefined
        && payload.description !== null
        && typeof payload.description !== 'string') {
        return { valid: false, message: 'description must be plain text.' };
    }
    const description = typeof payload.description === 'string'
        ? payload.description.trim()
        : null;
    if (description && description.length > 2000) {
        return { valid: false, message: 'description must not exceed 2000 characters.' };
    }
    if (payload.reason === 'OTHER' && !description) {
        return { valid: false, message: 'description is required when reason is OTHER.' };
    }
    return { valid: true, reason: payload.reason, description: description || null };
};

const buildWarrantyClaimDto = (claim, { includeAdmin = false } = {}) => claim ? ({
    id: claim.id,
    job_id: claim.job_id,
    warranty_id: claim.warranty_id,
    acceptance_cycle: Number(claim.acceptance_cycle),
    status: claim.status,
    reason: claim.reason,
    description: claim.description,
    submitted_at: claim.submitted_at,
    reviewed_at: claim.reviewed_at,
    resolved_at: claim.resolved_at,
    created_at: claim.createdAt,
    updated_at: claim.updatedAt,
    ...(includeAdmin ? {
        reviewed_by_admin_id: claim.reviewed_by_admin_id,
        admin_note: claim.admin_note
    } : {})
}) : null;

const createWarrantyClaimService = async (jobId, currentUser, payload = {}) => {
    if (!isValidUuid(jobId)) return serviceError('Invalid Job id.', 400, 'VALIDATION_ERROR');
    const body = validateClaimPayload(payload);
    if (!body.valid) return serviceError(body.message, 400, 'VALIDATION_ERROR');
    const transaction = await db.transaction();
    try {
        const job = await Job.findByPk(jobId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!job) return rollbackWith(transaction, serviceError('Job not found.', 404, 'JOB_NOT_FOUND'));
        if (currentUser?.role !== 'CUSTOMER' || job.customer_id !== currentUser.id) {
            return rollbackWith(transaction, serviceError('Only the Job Customer can create a Warranty Claim.', 403, 'NOT_JOB_CUSTOMER'));
        }
        if (job.current_status !== 'WARRANTY') {
            return rollbackWith(transaction, serviceError('Job is not in WARRANTY.', 409, 'JOB_NOT_IN_WARRANTY'));
        }
        const warranty = await JobWarranty.findOne({
            where: { job_id: job.id, acceptance_cycle: job.acceptance_cycle },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!warranty) return rollbackWith(transaction, serviceError('Warranty not found.', 404, 'WARRANTY_NOT_FOUND'));
        const activeClaim = await WarrantyClaim.findOne({
            where: { warranty_id: warranty.id, status: { [Op.in]: ACTIVE_CLAIM_STATUSES } },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (activeClaim) {
            if (activeClaim.status === 'PENDING_REVIEW'
                && activeClaim.reason === body.reason
                && (activeClaim.description || null) === body.description) {
                await transaction.commit();
                return {
                    EM: 'Warranty Claim already exists.',
                    EC: 0,
                    code: 'WARRANTY_CLAIM_ALREADY_EXISTS',
                    DT: { claim: buildWarrantyClaimDto(activeClaim) }
                };
            }
            return rollbackWith(transaction, serviceError('An active Warranty Claim already exists.', 409, 'WARRANTY_CLAIM_ALREADY_ACTIVE'));
        }
        if (warranty.status !== 'ACTIVE') {
            return rollbackWith(transaction, serviceError('Warranty is not active.', 409, 'WARRANTY_NOT_ACTIVE'));
        }
        if (warranty.released_at) {
            return rollbackWith(transaction, serviceError('Warranty funds were already released.', 409, 'WARRANTY_ALREADY_RELEASED'));
        }
        const submittedAt = new Date();
        if (submittedAt >= new Date(warranty.ends_at)) {
            return rollbackWith(transaction, serviceError('The Warranty Claim window has expired.', 409, 'WARRANTY_CLAIM_WINDOW_EXPIRED'));
        }

        const evidence = await EvidenceVault.findAll({
            where: evidenceWhere(job, 'WARRANTY_CLAIM', { uploader_id: job.customer_id }),
            transaction,
            lock: transaction.LOCK.UPDATE,
            order: [['uploaded_at', 'ASC']]
        });
        const existingLinks = evidence.length === 0 ? [] : await WarrantyClaimEvidence.findAll({
            where: { evidence_id: { [Op.in]: evidence.map((item) => item.id) } },
            attributes: ['evidence_id'],
            transaction
        });
        const linkedIds = new Set(existingLinks.map((link) => link.evidence_id));
        const availableEvidence = evidence.filter((item) => !linkedIds.has(item.id));
        if (availableEvidence.length < 1) {
            return rollbackWith(transaction, serviceError('At least one Claim Evidence image is required.', 409, 'WARRANTY_CLAIM_EVIDENCE_REQUIRED'));
        }

        const claim = await WarrantyClaim.create({
            job_id: job.id,
            acceptance_cycle: job.acceptance_cycle,
            warranty_id: warranty.id,
            customer_id: job.customer_id,
            handyman_id: job.selected_handyman_id,
            status: 'PENDING_REVIEW',
            reason: body.reason,
            description: body.description,
            submitted_at: submittedAt
        }, { transaction });
        await WarrantyClaimEvidence.bulkCreate(
            availableEvidence.map((item) => ({
                claim_id: claim.id,
                evidence_id: item.id,
                snapshotted_at: submittedAt
            })),
            { transaction }
        );
        await warranty.update({ status: 'CLAIM_PENDING' }, { transaction });
        await transaction.commit();

        emitJobLifecycleEvent({
            event: JOB_LIFECYCLE_EVENTS.WARRANTY_CLAIM_CREATED,
            userIds: [job.customer_id, job.selected_handyman_id],
            payload: {
                job_id: job.id,
                acceptance_cycle: Number(job.acceptance_cycle),
                warranty_id: warranty.id,
                claim_id: claim.id,
                current_status: 'WARRANTY',
                warranty_status: 'CLAIM_PENDING',
                occurred_at: submittedAt
            }
        });
        return {
            EM: 'Warranty Claim created successfully.',
            EC: 0,
            code: 'WARRANTY_CLAIM_CREATED',
            DT: { claim: buildWarrantyClaimDto(claim) }
        };
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('[warranty] Create Claim failed.', { job_id: jobId, error: error?.message });
        return serviceError('Unable to create Warranty Claim.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const canReadWarranty = (job, user) => user?.role === 'ADMIN'
    || (user?.role === 'CUSTOMER' && job.customer_id === user.id)
    || (user?.role === 'HANDYMAN' && job.selected_handyman_id === user.id);

const listWarrantyClaimsService = async (jobId, currentUser) => {
    if (!isValidUuid(jobId)) return serviceError('Invalid Job id.', 400, 'VALIDATION_ERROR');
    try {
        const job = await Job.findByPk(jobId);
        if (!job || !canReadWarranty(job, currentUser)) {
            return serviceError('Warranty Claims not found.', 404, 'WARRANTY_CLAIM_NOT_FOUND');
        }
        const claims = await WarrantyClaim.findAll({
            where: { job_id: job.id, acceptance_cycle: job.acceptance_cycle },
            order: [['submitted_at', 'DESC']]
        });
        return {
            EM: 'Warranty Claims retrieved successfully.',
            EC: 0,
            code: 'WARRANTY_CLAIMS_RETRIEVED',
            DT: {
                claims: claims.map((claim) => buildWarrantyClaimDto(claim, {
                    includeAdmin: currentUser.role === 'ADMIN'
                }))
            }
        };
    } catch (error) {
        console.error('[warranty] List Claims failed.', { job_id: jobId, error: error?.message });
        return serviceError('Unable to retrieve Warranty Claims.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const getWarrantyClaimEvidenceService = async (jobId, claimId, currentUser) => {
    if (!isValidUuid(jobId) || !isValidUuid(claimId)) {
        return serviceError('Invalid Job or Claim id.', 400, 'VALIDATION_ERROR');
    }
    try {
        const job = await Job.findByPk(jobId);
        if (!job || !canReadWarranty(job, currentUser)) {
            return serviceError('Claim Evidence not found.', 404, 'EVIDENCE_NOT_FOUND');
        }
        const claim = await WarrantyClaim.findOne({
            where: { id: claimId, job_id: job.id, acceptance_cycle: job.acceptance_cycle }
        });
        if (!claim) return serviceError('Claim Evidence not found.', 404, 'EVIDENCE_NOT_FOUND');
        const links = await WarrantyClaimEvidence.findAll({
            where: { claim_id: claim.id },
            attributes: ['evidence_id']
        });
        const evidence = links.length === 0 ? [] : await EvidenceVault.findAll({
            where: { id: { [Op.in]: links.map((link) => link.evidence_id) } },
            order: [['uploaded_at', 'ASC']]
        });
        return {
            EM: 'Claim Evidence retrieved successfully.',
            EC: 0,
            code: 'WARRANTY_CLAIM_EVIDENCE_RETRIEVED',
            DT: {
                claim: buildWarrantyClaimDto(claim, { includeAdmin: currentUser.role === 'ADMIN' }),
                evidence: evidence.map((item) => buildEvidenceDto(item, {
                    includeAudit: currentUser.role === 'ADMIN',
                    includeManagedState: true,
                    isLocked: true,
                    deletable: false
                }))
            }
        };
    } catch (error) {
        console.error('[warranty] Get Claim Evidence failed.', { job_id: jobId, claim_id: claimId, error: error?.message });
        return serviceError('Unable to retrieve Claim Evidence.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

export {
    CLAIM_REASONS,
    buildWarrantyClaimDto,
    createWarrantyClaimService,
    getWarrantyClaimEvidenceService,
    listWarrantyClaimsService,
    validateClaimPayload
};
