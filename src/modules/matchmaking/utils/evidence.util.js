import { createHash, randomUUID } from 'node:crypto';
import {
    destroyCloudinaryImage,
    uploadCloudinaryImageBuffer
} from '../../../core/utils/cloudinary.util.js';

const EVIDENCE_STAGES = Object.freeze([
    'BEFORE',
    'DURING',
    'AFTER',
    'WARRANTY_CLAIM',
    'WARRANTY'
]);

const readPositiveInteger = (value, fallback) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const getEvidenceConfig = () => ({
    maxFilesPerStage: readPositiveInteger(
        process.env.JOB_EVIDENCE_MAX_FILES_PER_STAGE,
        5
    )
});

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
        const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        return buffer.length >= signature.length
            && buffer.subarray(0, signature.length).equals(signature);
    }
    return false;
};

const validateEvidenceImage = (file) => {
    if (!file || !Buffer.isBuffer(file.buffer)) {
        return { valid: false, status: 400, code: 'IMAGE_REQUIRED', message: 'A single image file is required.' };
    }
    if (!['image/jpeg', 'image/png'].includes(file.mimetype) || !hasValidImageSignature(file)) {
        return {
            valid: false,
            status: 415,
            code: 'INVALID_IMAGE_TYPE',
            message: 'Only valid JPEG and PNG images are supported.'
        };
    }
    return { valid: true };
};

const buildEvidenceDto = (evidence, {
    includeAudit = false,
    includeManagedState = false,
    isLocked = false,
    deletable = false
} = {}) => ({
    id: evidence.id,
    job_id: evidence.job_id,
    acceptance_cycle: Number(evidence.acceptance_cycle),
    stage: evidence.stage,
    media_type: evidence.media_type,
    media_url: evidence.media_url,
    mime_type: evidence.mime_type,
    file_size: evidence.file_size,
    uploaded_at: evidence.uploaded_at,
    ...(includeManagedState ? {
        is_locked: Boolean(isLocked),
        deletable: Boolean(deletable) && !isLocked
    } : {}),
    ...(includeAudit ? {
        uploader_id: evidence.uploader_id,
        customer_id: evidence.customer_id,
        handyman_id: evidence.handyman_id,
        selected_bid_id: evidence.selected_bid_id,
        file_hash: evidence.file_hash
    } : {})
});

const uploadEvidenceBuffer = async ({ file, job, stage }) => {
    if (!EVIDENCE_STAGES.includes(stage)) throw new Error('Unsupported evidence stage.');
    const acceptanceCycle = Number(job.acceptance_cycle);
    const folderStage = stage.toLowerCase().replaceAll('_', '-');
    const uploaded = await uploadCloudinaryImageBuffer({
        buffer: file.buffer,
        folder: `final_year_project/jobs/${job.id}/cycles/${acceptanceCycle}/${folderStage}`,
        publicId: `${folderStage}_${randomUUID()}`
    });
    if (!uploaded?.public_id
        || !uploaded?.secure_url
        || !Number.isFinite(Number(uploaded?.bytes))
        || !['jpg', 'jpeg', 'png'].includes(String(uploaded?.format || '').toLowerCase())) {
        if (uploaded?.public_id) await destroyCloudinaryImage(uploaded.public_id);
        throw new Error('Cloudinary returned incomplete upload metadata.');
    }
    return {
        publicId: uploaded.public_id,
        url: uploaded.secure_url,
        bytes: Number(uploaded.bytes || file.size),
        fileHash: createHash('sha256').update(file.buffer).digest('hex')
    };
};

const cleanupEvidenceImage = async (publicId, context = {}) => {
    if (!publicId) return;
    try {
        await destroyCloudinaryImage(publicId);
    } catch (error) {
        console.error('[evidence] Cloudinary cleanup failed.', {
            ...context,
            cloudinary_public_id: publicId,
            error: error?.message || 'Unknown error'
        });
    }
};

export {
    EVIDENCE_STAGES,
    buildEvidenceDto,
    cleanupEvidenceImage,
    getEvidenceConfig,
    uploadEvidenceBuffer,
    validateEvidenceImage
};
