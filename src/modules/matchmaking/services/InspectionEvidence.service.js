import { createHash, randomUUID } from 'crypto';
import db from '../../../core/database/connection.js';
import {
    destroyCloudinaryImage,
    uploadCloudinaryImageBuffer
} from '../../../core/utils/cloudinary.util.js';
import EvidenceVault from '../../fintech/models/EvidenceVault.model.js';
import Job from '../models/Job.model.js';
import JobQuote from '../models/JobQuote.model.js';
import {
    isValidUuid,
    serviceError,
    validateAcceptedJobInvariants
} from './AcceptedJob.service.js';
import { getQuoteConfig } from '../utils/quote.util.js';

const hasValidImageSignature = (file) => {
    const buffer = file?.buffer;
    if (!Buffer.isBuffer(buffer)) return false;
    if (file.mimetype === 'image/jpeg') {
        return buffer.length >= 3
            && buffer[0] === 0xff
            && buffer[1] === 0xd8
            && buffer[2] === 0xff;
    }
    if (file.mimetype === 'image/png') {
        const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        return buffer.length >= pngSignature.length
            && buffer.subarray(0, pngSignature.length).equals(pngSignature);
    }
    return false;
};

const buildEvidenceDto = (evidence, { includeAudit = false } = {}) => ({
    id: evidence.id,
    job_id: evidence.job_id,
    acceptance_cycle: Number(evidence.acceptance_cycle),
    stage: evidence.stage,
    media_type: evidence.media_type,
    media_url: evidence.media_url,
    mime_type: evidence.mime_type,
    file_size: evidence.file_size,
    uploaded_at: evidence.uploaded_at,
    ...(includeAudit ? {
        uploader_id: evidence.uploader_id,
        customer_id: evidence.customer_id,
        handyman_id: evidence.handyman_id,
        selected_bid_id: evidence.selected_bid_id,
        file_hash: evidence.file_hash
    } : {})
});

const ensureSelectedHandyman = (job, handymanId) => {
    if (job.selected_handyman_id !== handymanId) {
        return serviceError(
            'Only the selected handyman can manage BEFORE evidence.',
            403,
            'NOT_SELECTED_HANDYMAN'
        );
    }
    return null;
};

const validateEvidenceWritableJob = async (job, handymanId, transaction = null) => {
    const selectedError = ensureSelectedHandyman(job, handymanId);
    if (selectedError) return { error: selectedError };
    if (job.current_status !== 'ARRIVED') {
        const evidenceLockedStatuses = [
            'QUOTE_PENDING',
            'PAYMENT_PENDING',
            'CANCELLATION_REVIEW',
            'IN_PROGRESS',
            'CANCELLED'
        ];
        const evidenceLocked = evidenceLockedStatuses.includes(job.current_status);
        return {
            error: serviceError(
                evidenceLocked
                    ? 'BEFORE evidence is locked after Quote submission.'
                    : 'Job must be ARRIVED to manage BEFORE evidence.',
                409,
                evidenceLocked ? 'EVIDENCE_LOCKED' : 'JOB_NOT_ARRIVED',
                { current_status: job.current_status }
            )
        };
    }
    const options = transaction ? { transaction } : {};
    const invariant = await validateAcceptedJobInvariants(job, options);
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
    return invariant;
};

const findCurrentQuote = (job, options = {}) => JobQuote.findOne({
    where: {
        job_id: job.id,
        acceptance_cycle: job.acceptance_cycle,
        version: 1
    },
    ...options
});

const countCurrentBeforeEvidence = (job, options = {}) => EvidenceVault.count({
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
    ...options
});

const cleanupUploadedImage = async (publicId, context) => {
    if (!publicId) return;
    try {
        await destroyCloudinaryImage(publicId);
    } catch (error) {
        console.error('[evidence] Cloudinary orphan cleanup failed.', {
            ...context,
            cloudinary_public_id: publicId,
            error: error?.message || 'Unknown error'
        });
    }
};

const uploadBeforeEvidenceService = async (jobId, handymanId, file) => {
    if (!isValidUuid(jobId)) {
        return serviceError('Invalid job id.', 400, 'VALIDATION_ERROR');
    }
    if (!file || !Buffer.isBuffer(file.buffer)) {
        return serviceError('A single image file is required.', 400, 'IMAGE_REQUIRED');
    }
    if (!['image/jpeg', 'image/png'].includes(file.mimetype) || !hasValidImageSignature(file)) {
        return serviceError('Only valid JPEG and PNG images are supported.', 415, 'INVALID_IMAGE_TYPE');
    }

    let preflightJob;
    try {
        preflightJob = await Job.findByPk(jobId);
        if (!preflightJob) return serviceError('Job not found.', 404, 'JOB_NOT_FOUND');
        const validation = await validateEvidenceWritableJob(preflightJob, handymanId);
        if (validation.error) return validation.error;

        const [currentQuote, evidenceCount] = await Promise.all([
            findCurrentQuote(preflightJob),
            countCurrentBeforeEvidence(preflightJob)
        ]);
        if (currentQuote && currentQuote.status !== 'DRAFT') {
            return serviceError('BEFORE evidence is locked after Quote submission.', 409, 'EVIDENCE_LOCKED');
        }
        const config = getQuoteConfig();
        if (evidenceCount >= config.beforeEvidenceMaxFiles) {
            return serviceError(
                `A maximum of ${config.beforeEvidenceMaxFiles} BEFORE images is allowed.`,
                409,
                'BEFORE_EVIDENCE_LIMIT_REACHED'
            );
        }
    } catch (error) {
        console.error('>>> Evidence upload preflight failed:', error?.message || 'Unknown error');
        return serviceError('Unable to validate evidence upload.', 500, 'INTERNAL_SERVER_ERROR');
    }

    const acceptanceCycle = Number(preflightJob.acceptance_cycle);
    const folder = `final_year_project/jobs/${preflightJob.id}/cycles/${acceptanceCycle}/before`;
    const fileHash = createHash('sha256').update(file.buffer).digest('hex');
    let uploaded;
    try {
        uploaded = await uploadCloudinaryImageBuffer({
            buffer: file.buffer,
            folder,
            publicId: `before_${randomUUID()}`
        });
    } catch (error) {
        console.error('[evidence] Cloudinary upload failed.', {
            job_id: jobId,
            acceptance_cycle: acceptanceCycle,
            error: error?.message || 'Unknown error'
        });
        return serviceError('Unable to upload evidence image.', 502, 'CLOUDINARY_UPLOAD_FAILED');
    }
    if (!uploaded?.public_id
        || !uploaded?.secure_url
        || !Number.isFinite(Number(uploaded?.bytes))
        || !['jpg', 'jpeg', 'png'].includes(String(uploaded?.format || '').toLowerCase())) {
        await cleanupUploadedImage(uploaded?.public_id, {
            job_id: jobId,
            acceptance_cycle: acceptanceCycle
        });
        return serviceError(
            'Cloudinary returned incomplete upload metadata.',
            502,
            'CLOUDINARY_UPLOAD_FAILED'
        );
    }

    let transaction;
    try {
        transaction = await db.transaction();
    } catch (error) {
        await cleanupUploadedImage(uploaded.public_id, {
            job_id: jobId,
            acceptance_cycle: acceptanceCycle
        });
        console.error('>>> Unable to open evidence database transaction:', error?.message || 'Unknown error');
        return serviceError('Unable to save BEFORE evidence.', 500, 'INTERNAL_SERVER_ERROR');
    }
    const failAfterUpload = async (result) => {
        if (!transaction.finished) await transaction.rollback();
        await cleanupUploadedImage(uploaded.public_id, {
            job_id: jobId,
            acceptance_cycle: acceptanceCycle
        });
        return result;
    };

    try {
        const job = await Job.findByPk(jobId, {
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!job) return failAfterUpload(serviceError('Job not found.', 404, 'JOB_NOT_FOUND'));
        if (Number(job.acceptance_cycle) !== acceptanceCycle) {
            return failAfterUpload(serviceError(
                'Job acceptance cycle changed during upload.',
                409,
                'ACCEPTANCE_CYCLE_INCONSISTENT'
            ));
        }
        const validation = await validateEvidenceWritableJob(job, handymanId, transaction);
        if (validation.error) return failAfterUpload(validation.error);

        const currentQuote = await findCurrentQuote(job, {
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (currentQuote && currentQuote.status !== 'DRAFT') {
            return failAfterUpload(serviceError(
                'BEFORE evidence is locked after Quote submission.',
                409,
                'EVIDENCE_LOCKED'
            ));
        }
        const config = getQuoteConfig();
        const evidenceCount = await countCurrentBeforeEvidence(job, { transaction });
        if (evidenceCount >= config.beforeEvidenceMaxFiles) {
            return failAfterUpload(serviceError(
                `A maximum of ${config.beforeEvidenceMaxFiles} BEFORE images is allowed.`,
                409,
                'BEFORE_EVIDENCE_LIMIT_REACHED'
            ));
        }

        const evidence = await EvidenceVault.create({
            job_id: job.id,
            acceptance_cycle: job.acceptance_cycle,
            customer_id: job.customer_id,
            handyman_id: job.selected_handyman_id,
            selected_bid_id: job.selected_bid_id,
            uploader_id: handymanId,
            stage: 'BEFORE',
            media_type: 'IMAGE',
            media_url: uploaded.secure_url,
            cloudinary_public_id: uploaded.public_id,
            mime_type: file.mimetype,
            file_size: Number(uploaded.bytes || file.size),
            file_hash: fileHash,
            uploaded_at: new Date()
        }, { transaction });

        await transaction.commit();
        return {
            EM: 'BEFORE evidence uploaded successfully.',
            EC: 0,
            code: 'BEFORE_EVIDENCE_CREATED',
            DT: { evidence: buildEvidenceDto(evidence) }
        };
    } catch (error) {
        const committed = transaction.finished === 'commit';
        if (!transaction.finished) await transaction.rollback();
        if (!committed) {
            await cleanupUploadedImage(uploaded.public_id, {
                job_id: jobId,
                acceptance_cycle: acceptanceCycle
            });
        }
        console.error('>>> Error in uploadBeforeEvidenceService:', error?.message || 'Unknown error');
        return serviceError('Unable to save BEFORE evidence.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const listBeforeEvidenceService = async (jobId, currentUser) => {
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
            return serviceError('Evidence not found.', 404, 'EVIDENCE_NOT_FOUND');
        }

        const currentQuote = await findCurrentQuote(job);
        const customerVisibleQuoteStatuses = ['SUBMITTED', 'ACCEPTED', 'REJECTED'];
        if (isCustomer
            && (['IN_PROGRESS', 'WARRANTY', 'CLOSED'].includes(job.current_status)
                || !currentQuote
                || !customerVisibleQuoteStatuses.includes(currentQuote.status))) {
            return serviceError('Evidence not found.', 404, 'EVIDENCE_NOT_FOUND');
        }
        const evidence = await EvidenceVault.findAll({
            where: {
                job_id: job.id,
                acceptance_cycle: job.acceptance_cycle,
                customer_id: job.customer_id,
                handyman_id: job.selected_handyman_id,
                selected_bid_id: job.selected_bid_id,
                stage: 'BEFORE',
                media_type: 'IMAGE'
            },
            order: [['uploaded_at', 'ASC']]
        });

        return {
            EM: 'BEFORE evidence retrieved successfully.',
            EC: 0,
            code: 'BEFORE_EVIDENCE_RETRIEVED',
            DT: {
                evidence: evidence.map((item) => buildEvidenceDto(item, {
                    includeAudit: isAdmin
                }))
            }
        };
    } catch (error) {
        console.error('>>> Error in listBeforeEvidenceService:', error?.message || 'Unknown error');
        return serviceError('Unable to retrieve BEFORE evidence.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const deleteBeforeEvidenceService = async (jobId, evidenceId, handymanId) => {
    if (!isValidUuid(jobId) || !isValidUuid(evidenceId)) {
        return serviceError('Invalid job or evidence id.', 400, 'VALIDATION_ERROR');
    }

    const transaction = await db.transaction();
    let deletedEvidence;
    try {
        const job = await Job.findByPk(jobId, {
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!job) {
            await transaction.rollback();
            return serviceError('Job not found.', 404, 'JOB_NOT_FOUND');
        }
        const validation = await validateEvidenceWritableJob(job, handymanId, transaction);
        if (validation.error) {
            await transaction.rollback();
            return validation.error;
        }

        const currentQuote = await findCurrentQuote(job, {
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (currentQuote && currentQuote.status !== 'DRAFT') {
            await transaction.rollback();
            return serviceError(
                'BEFORE evidence is locked after Quote submission.',
                409,
                'EVIDENCE_LOCKED'
            );
        }

        deletedEvidence = await EvidenceVault.findOne({
            where: {
                id: evidenceId,
                job_id: job.id,
                acceptance_cycle: job.acceptance_cycle,
                customer_id: job.customer_id,
                handyman_id: job.selected_handyman_id,
                selected_bid_id: job.selected_bid_id,
                uploader_id: handymanId,
                stage: 'BEFORE',
                media_type: 'IMAGE'
            },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!deletedEvidence) {
            await transaction.rollback();
            return serviceError('Evidence not found.', 404, 'EVIDENCE_NOT_FOUND');
        }

        await deletedEvidence.destroy({ transaction });
        await transaction.commit();
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('>>> Error in deleteBeforeEvidenceService:', error?.message || 'Unknown error');
        return serviceError('Unable to delete BEFORE evidence.', 500, 'INTERNAL_SERVER_ERROR');
    }

    try {
        await destroyCloudinaryImage(deletedEvidence.cloudinary_public_id);
    } catch (error) {
        console.error('[evidence] Cloudinary delete failed after database commit.', {
            job_id: jobId,
            evidence_id: evidenceId,
            cloudinary_public_id: deletedEvidence.cloudinary_public_id,
            error: error?.message || 'Unknown error'
        });
    }

    return {
        EM: 'BEFORE evidence deleted successfully.',
        EC: 0,
        code: 'BEFORE_EVIDENCE_DELETED',
        DT: { job_id: jobId, evidence_id: evidenceId }
    };
};

export {
    deleteBeforeEvidenceService,
    listBeforeEvidenceService,
    uploadBeforeEvidenceService
};
