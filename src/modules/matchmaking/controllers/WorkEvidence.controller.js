import multer from 'multer';
import { uploadEvidenceMiddleware } from '../../../core/config/cloudinary.config.js';
import {
    deleteWorkEvidenceService,
    listWorkEvidenceService,
    uploadWorkEvidenceService
} from '../services/WorkEvidence.service.js';

const getHttpStatus = (result, successStatus = 200) => {
    if (result.EC === 0) return successStatus;
    return [400, 401, 403, 404, 409, 413, 415, 502].includes(result.EC)
        ? result.EC
        : 500;
};

const mapMultipartError = (error) => {
    if (error?.code === 'LIMIT_FILE_SIZE') {
        return {
            status: 413,
            envelope: { EM: 'Evidence image exceeds the configured size limit.', EC: 413, code: 'IMAGE_TOO_LARGE', DT: '' }
        };
    }
    if (error?.code === 'INVALID_IMAGE_TYPE') {
        return {
            status: 415,
            envelope: { EM: error.message, EC: 415, code: 'INVALID_IMAGE_TYPE', DT: '' }
        };
    }
    return {
        status: 400,
        envelope: {
            EM: error instanceof multer.MulterError
                ? 'Invalid evidence multipart payload.'
                : 'Unable to process image upload.',
            EC: 400,
            code: 'INVALID_UPLOAD_PAYLOAD',
            DT: ''
        }
    };
};

const createUploadHandler = (stage) => (req, res) => {
    uploadEvidenceMiddleware(req, res, async (multipartError) => {
        if (multipartError) {
            const mapped = mapMultipartError(multipartError);
            return res.status(mapped.status).json(mapped.envelope);
        }
        try {
            const result = await uploadWorkEvidenceService(
                req.params.jobId,
                stage,
                req.user.id,
                req.file
            );
            return res.status(getHttpStatus(result, result.EC === 0 ? 201 : 200)).json(result);
        } catch (error) {
            console.error('[evidence] Upload controller failed.', error);
            return res.status(500).json({ EM: 'Internal server error.', EC: 500, code: 'INTERNAL_SERVER_ERROR', DT: '' });
        }
    });
};

const createListHandler = (stage) => async (req, res) => {
    try {
        const result = await listWorkEvidenceService(req.params.jobId, stage, req.user);
        return res.status(getHttpStatus(result)).json(result);
    } catch (error) {
        console.error('[evidence] List controller failed.', error);
        return res.status(500).json({ EM: 'Internal server error.', EC: 500, code: 'INTERNAL_SERVER_ERROR', DT: '' });
    }
};

const createDeleteHandler = (stage) => async (req, res) => {
    try {
        const result = await deleteWorkEvidenceService(
            req.params.jobId,
            req.params.evidenceId,
            stage,
            req.user.id
        );
        return res.status(getHttpStatus(result)).json(result);
    } catch (error) {
        console.error('[evidence] Delete controller failed.', error);
        return res.status(500).json({ EM: 'Internal server error.', EC: 500, code: 'INTERNAL_SERVER_ERROR', DT: '' });
    }
};

const handleUploadDuringEvidence = createUploadHandler('DURING');
const handleListDuringEvidence = createListHandler('DURING');
const handleDeleteDuringEvidence = createDeleteHandler('DURING');
const handleUploadAfterEvidence = createUploadHandler('AFTER');
const handleListAfterEvidence = createListHandler('AFTER');
const handleDeleteAfterEvidence = createDeleteHandler('AFTER');
const handleUploadClaimEvidence = createUploadHandler('WARRANTY_CLAIM');
const handleListClaimDraftEvidence = createListHandler('WARRANTY_CLAIM');
const handleDeleteClaimEvidence = createDeleteHandler('WARRANTY_CLAIM');
const handleUploadWarrantyEvidence = createUploadHandler('WARRANTY');
const handleListWarrantyEvidence = createListHandler('WARRANTY');
const handleDeleteWarrantyEvidence = createDeleteHandler('WARRANTY');

export {
    handleDeleteAfterEvidence,
    handleDeleteClaimEvidence,
    handleDeleteDuringEvidence,
    handleDeleteWarrantyEvidence,
    handleListAfterEvidence,
    handleListClaimDraftEvidence,
    handleListDuringEvidence,
    handleListWarrantyEvidence,
    handleUploadAfterEvidence,
    handleUploadClaimEvidence,
    handleUploadDuringEvidence,
    handleUploadWarrantyEvidence
};
