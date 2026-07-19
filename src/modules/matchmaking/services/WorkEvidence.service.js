import { Op } from 'sequelize';
import db from '../../../core/database/connection.js';
import { destroyCloudinaryImage } from '../../../core/utils/cloudinary.util.js';
import EvidenceVault from '../../fintech/models/EvidenceVault.model.js';
import Job from '../models/Job.model.js';
import JobCompletionRequest from '../models/JobCompletionRequest.model.js';
import JobCompletionRequestEvidence from '../models/JobCompletionRequestEvidence.model.js';
import JobWarranty from '../models/JobWarranty.model.js';
import WarrantyClaim from '../models/WarrantyClaim.model.js';
import WarrantyClaimEvidence from '../models/WarrantyClaimEvidence.model.js';
import WarrantyCompletionRequestEvidence from '../models/WarrantyCompletionRequestEvidence.model.js';
import {
    buildEvidenceDto,
    cleanupEvidenceImage,
    getEvidenceConfig,
    uploadEvidenceBuffer,
    validateEvidenceImage
} from '../utils/evidence.util.js';
import { isValidUuid, serviceError } from './AcceptedJob.service.js';

const MANAGED_STAGES = Object.freeze(['DURING', 'AFTER', 'WARRANTY_CLAIM', 'WARRANTY']);
const ACTIVE_CLAIM_STATUSES = Object.freeze([
    'PENDING_REVIEW',
    'APPROVED_REWORK_REQUIRED',
    'REVIEW_REQUIRED'
]);

const evidenceWhere = (job, stage, extra = {}) => ({
    job_id: job.id,
    acceptance_cycle: job.acceptance_cycle,
    customer_id: job.customer_id,
    handyman_id: job.selected_handyman_id,
    selected_bid_id: job.selected_bid_id,
    stage,
    media_type: 'IMAGE',
    ...extra
});

const loadLockedEvidenceIds = async (evidenceIds, options = {}) => {
    if (!Array.isArray(evidenceIds) || evidenceIds.length === 0) return new Set();
    const queryOptions = options.transaction ? {
        transaction: options.transaction,
        ...(options.lock ? { lock: options.transaction.LOCK.UPDATE } : {})
    } : {};
    const where = { evidence_id: { [Op.in]: evidenceIds } };
    const [completion, claim, warrantyCompletion] = await Promise.all([
        JobCompletionRequestEvidence.findAll({ where, attributes: ['evidence_id'], ...queryOptions }),
        WarrantyClaimEvidence.findAll({ where, attributes: ['evidence_id'], ...queryOptions }),
        WarrantyCompletionRequestEvidence.findAll({ where, attributes: ['evidence_id'], ...queryOptions })
    ]);
    return new Set(
        [...completion, ...claim, ...warrantyCompletion].map((link) => link.evidence_id)
    );
};

const findEvidenceSnapshot = async (evidenceId, options = {}) => {
    const lockedIds = await loadLockedEvidenceIds([evidenceId], options);
    return lockedIds.has(evidenceId);
};

const countUnlockedStageEvidence = async (job, stage, options = {}) => {
    const records = await EvidenceVault.findAll({
        where: evidenceWhere(job, stage),
        attributes: ['id'],
        ...(options.transaction ? { transaction: options.transaction } : {})
    });
    if (records.length === 0) return 0;
    const linkedIds = new Set();
    const ids = records.map((record) => record.id);
    const queryOptions = options.transaction ? { transaction: options.transaction } : {};
    const [completionLinks, claimLinks, warrantyLinks] = await Promise.all([
        JobCompletionRequestEvidence.findAll({
            where: { evidence_id: { [Op.in]: ids } },
            attributes: ['evidence_id'],
            ...queryOptions
        }),
        WarrantyClaimEvidence.findAll({
            where: { evidence_id: { [Op.in]: ids } },
            attributes: ['evidence_id'],
            ...queryOptions
        }),
        WarrantyCompletionRequestEvidence.findAll({
            where: { evidence_id: { [Op.in]: ids } },
            attributes: ['evidence_id'],
            ...queryOptions
        })
    ]);
    [...completionLinks, ...claimLinks, ...warrantyLinks]
        .forEach((link) => linkedIds.add(link.evidence_id));
    return records.filter((record) => !linkedIds.has(record.id)).length;
};

const validateWritableContext = async ({ job, stage, userId, transaction = null }) => {
    const options = transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {};
    if (['DURING', 'AFTER'].includes(stage)) {
        if (job.selected_handyman_id !== userId) {
            return { error: serviceError('Only the selected handyman can manage work evidence.', 403, 'NOT_SELECTED_HANDYMAN') };
        }
        if (job.current_status !== 'IN_PROGRESS') {
            return { error: serviceError('Job must be IN_PROGRESS.', 409, 'JOB_NOT_IN_PROGRESS') };
        }
        const pending = await JobCompletionRequest.findOne({
            where: {
                job_id: job.id,
                acceptance_cycle: job.acceptance_cycle,
                status: 'PENDING'
            },
            ...options
        });
        if (pending) {
            return { error: serviceError('Completion evidence is locked while a request is pending.', 409, 'COMPLETION_EVIDENCE_LOCKED') };
        }
        return { pendingRequest: null };
    }

    const warranty = await JobWarranty.findOne({
        where: { job_id: job.id, acceptance_cycle: job.acceptance_cycle },
        ...options
    });
    if (job.current_status !== 'WARRANTY' || !warranty) {
        return { error: serviceError('Job is not in WARRANTY.', 409, 'JOB_NOT_IN_WARRANTY') };
    }
    if (warranty.released_at || warranty.status === 'COMPLETED') {
        return { error: serviceError('Warranty funds were already released.', 409, 'WARRANTY_ALREADY_RELEASED') };
    }

    if (stage === 'WARRANTY_CLAIM') {
        if (job.customer_id !== userId) {
            return { error: serviceError('Only the job customer can manage Claim evidence.', 403, 'NOT_JOB_CUSTOMER') };
        }
        if (warranty.status !== 'ACTIVE') {
            return { error: serviceError('Warranty is not active.', 409, 'WARRANTY_NOT_ACTIVE') };
        }
        if (new Date() >= new Date(warranty.ends_at)) {
            return { error: serviceError('The Warranty Claim window has expired.', 409, 'WARRANTY_CLAIM_WINDOW_EXPIRED') };
        }
        const activeClaim = await WarrantyClaim.findOne({
            where: { warranty_id: warranty.id, status: { [Op.in]: ACTIVE_CLAIM_STATUSES } },
            ...options
        });
        if (activeClaim) {
            return { error: serviceError('An active Warranty Claim already exists.', 409, 'WARRANTY_CLAIM_ALREADY_ACTIVE') };
        }
        return { warranty, claim: null };
    }

    if (job.selected_handyman_id !== userId) {
        return { error: serviceError('Only the selected handyman can manage Warranty evidence.', 403, 'NOT_SELECTED_HANDYMAN') };
    }
    if (warranty.status !== 'REWORK_REQUIRED') {
        return { error: serviceError('Warranty rework is not required.', 409, 'WARRANTY_REWORK_NOT_REQUIRED') };
    }
    const claim = await WarrantyClaim.findOne({
        where: {
            warranty_id: warranty.id,
            status: 'APPROVED_REWORK_REQUIRED'
        },
        ...options
    });
    if (!claim) {
        return { error: serviceError('Approved rework Claim not found.', 409, 'WARRANTY_REWORK_NOT_REQUIRED') };
    }
    return { warranty, claim };
};

const uploadWorkEvidenceService = async (jobId, stage, userId, file) => {
    if (!isValidUuid(jobId) || !MANAGED_STAGES.includes(stage)) {
        return serviceError('Invalid Job id or evidence stage.', 400, 'VALIDATION_ERROR');
    }
    const fileValidation = validateEvidenceImage(file);
    if (!fileValidation.valid) {
        return serviceError(fileValidation.message, fileValidation.status, fileValidation.code);
    }

    let preflightJob;
    try {
        preflightJob = await Job.findByPk(jobId);
        if (!preflightJob) return serviceError('Job not found.', 404, 'JOB_NOT_FOUND');
        const context = await validateWritableContext({ job: preflightJob, stage, userId });
        if (context.error) return context.error;
        const unlockedCount = await countUnlockedStageEvidence(preflightJob, stage);
        if (unlockedCount >= getEvidenceConfig().maxFilesPerStage) {
            return serviceError('Evidence limit reached for the current request cycle.', 409, 'EVIDENCE_LIMIT_REACHED');
        }
    } catch (error) {
        console.error('[evidence] Upload preflight failed.', { job_id: jobId, stage, error: error?.message });
        return serviceError('Unable to validate evidence upload.', 500, 'INTERNAL_SERVER_ERROR');
    }

    let uploaded;
    try {
        uploaded = await uploadEvidenceBuffer({ file, job: preflightJob, stage });
    } catch (error) {
        console.error('[evidence] Cloudinary upload failed.', { job_id: jobId, stage, error: error?.message });
        return serviceError('Unable to upload evidence image.', 502, 'CLOUDINARY_UPLOAD_FAILED');
    }

    const transaction = await db.transaction();
    const fail = async (result) => {
        if (!transaction.finished) await transaction.rollback();
        await cleanupEvidenceImage(uploaded.publicId, { job_id: jobId, stage });
        return result;
    };
    try {
        const job = await Job.findByPk(jobId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!job) return fail(serviceError('Job not found.', 404, 'JOB_NOT_FOUND'));
        if (Number(job.acceptance_cycle) !== Number(preflightJob.acceptance_cycle)) {
            return fail(serviceError('Job acceptance cycle changed during upload.', 409, 'ACCEPTANCE_CYCLE_INCONSISTENT'));
        }
        const context = await validateWritableContext({ job, stage, userId, transaction });
        if (context.error) return fail(context.error);
        const unlockedCount = await countUnlockedStageEvidence(job, stage, { transaction });
        if (unlockedCount >= getEvidenceConfig().maxFilesPerStage) {
            return fail(serviceError('Evidence limit reached for the current request cycle.', 409, 'EVIDENCE_LIMIT_REACHED'));
        }

        const evidence = await EvidenceVault.create({
            ...evidenceWhere(job, stage),
            uploader_id: userId,
            media_url: uploaded.url,
            cloudinary_public_id: uploaded.publicId,
            mime_type: file.mimetype,
            file_size: uploaded.bytes,
            file_hash: uploaded.fileHash,
            uploaded_at: new Date()
        }, { transaction });
        await transaction.commit();
        return {
            EM: `${stage} evidence uploaded successfully.`,
            EC: 0,
            code: `${stage}_EVIDENCE_CREATED`,
            DT: {
                evidence: buildEvidenceDto(evidence, {
                    includeManagedState: true,
                    isLocked: false,
                    deletable: true
                })
            }
        };
    } catch (error) {
        const committed = transaction.finished === 'commit';
        if (!transaction.finished) await transaction.rollback();
        if (!committed) await cleanupEvidenceImage(uploaded.publicId, { job_id: jobId, stage });
        console.error('[evidence] Failed to save uploaded evidence.', { job_id: jobId, stage, error: error?.message });
        return serviceError('Unable to save evidence.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const listWorkEvidenceService = async (jobId, stage, currentUser) => {
    if (!isValidUuid(jobId) || !MANAGED_STAGES.includes(stage)) {
        return serviceError('Invalid Job id or evidence stage.', 400, 'VALIDATION_ERROR');
    }
    try {
        const job = await Job.findByPk(jobId);
        if (!job) return serviceError('Evidence not found.', 404, 'EVIDENCE_NOT_FOUND');
        const isAdmin = currentUser.role === 'ADMIN';
        const isHandyman = currentUser.role === 'HANDYMAN'
            && job.selected_handyman_id === currentUser.id;
        const isCustomerClaimOwner = stage === 'WARRANTY_CLAIM'
            && currentUser.role === 'CUSTOMER'
            && job.customer_id === currentUser.id;
        if (stage === 'WARRANTY_CLAIM' && !isAdmin && !isCustomerClaimOwner) {
            return serviceError('Evidence not found.', 404, 'EVIDENCE_NOT_FOUND');
        }
        if (stage !== 'WARRANTY_CLAIM' && !isAdmin && !isHandyman) {
            return serviceError('Evidence not found.', 404, 'EVIDENCE_NOT_FOUND');
        }
        const evidence = await EvidenceVault.findAll({
            where: evidenceWhere(job, stage),
            order: [['uploaded_at', 'ASC']]
        });
        const lockedIds = await loadLockedEvidenceIds(evidence.map((item) => item.id));
        const isManagingOwner = (stage === 'WARRANTY_CLAIM' && isCustomerClaimOwner)
            || (stage !== 'WARRANTY_CLAIM' && isHandyman);
        const writableContext = isManagingOwner && evidence.length > 0
            ? await validateWritableContext({
                job,
                stage,
                userId: currentUser.id
            })
            : null;
        const mayDelete = isManagingOwner && !writableContext?.error;
        return {
            EM: `${stage} evidence retrieved successfully.`,
            EC: 0,
            code: `${stage}_EVIDENCE_RETRIEVED`,
            DT: {
                evidence: evidence.map((item) => {
                    const isLocked = lockedIds.has(item.id);
                    return buildEvidenceDto(item, {
                        includeAudit: isAdmin,
                        includeManagedState: true,
                        isLocked,
                        deletable: mayDelete
                            && item.uploader_id === currentUser.id
                            && !isLocked
                    });
                })
            }
        };
    } catch (error) {
        console.error('[evidence] Failed to list evidence.', { job_id: jobId, stage, error: error?.message });
        return serviceError('Unable to retrieve evidence.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const deleteWorkEvidenceService = async (jobId, evidenceId, stage, userId) => {
    if (!isValidUuid(jobId) || !isValidUuid(evidenceId) || !MANAGED_STAGES.includes(stage)) {
        return serviceError('Invalid Job, evidence id, or stage.', 400, 'VALIDATION_ERROR');
    }
    const transaction = await db.transaction();
    let evidence;
    try {
        const job = await Job.findByPk(jobId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!job) {
            await transaction.rollback();
            return serviceError('Job not found.', 404, 'JOB_NOT_FOUND');
        }
        const context = await validateWritableContext({ job, stage, userId, transaction });
        if (context.error) {
            await transaction.rollback();
            return context.error;
        }
        evidence = await EvidenceVault.findOne({
            where: evidenceWhere(job, stage, { id: evidenceId, uploader_id: userId }),
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!evidence) {
            await transaction.rollback();
            return serviceError('Evidence not found.', 404, 'EVIDENCE_NOT_FOUND');
        }
        const snapshot = await findEvidenceSnapshot(evidence.id, { transaction, lock: true });
        if (snapshot) {
            await transaction.rollback();
            return serviceError('Snapshotted Evidence is immutable.', 409, 'COMPLETION_EVIDENCE_LOCKED');
        }
        await evidence.destroy({ transaction });
        await transaction.commit();
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('[evidence] Failed to delete evidence.', { job_id: jobId, evidence_id: evidenceId, error: error?.message });
        return serviceError('Unable to delete evidence.', 500, 'INTERNAL_SERVER_ERROR');
    }

    try {
        await destroyCloudinaryImage(evidence.cloudinary_public_id);
    } catch (error) {
        console.error('[evidence] Cloudinary delete failed after commit.', {
            evidence_id: evidence.id,
            error: error?.message
        });
    }
    return {
        EM: `${stage} evidence deleted successfully.`,
        EC: 0,
        code: `${stage}_EVIDENCE_DELETED`,
        DT: { job_id: jobId, evidence_id: evidenceId }
    };
};

export {
    ACTIVE_CLAIM_STATUSES,
    countUnlockedStageEvidence,
    deleteWorkEvidenceService,
    evidenceWhere,
    findEvidenceSnapshot,
    loadLockedEvidenceIds,
    listWorkEvidenceService,
    uploadWorkEvidenceService,
    validateWritableContext
};
