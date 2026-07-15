import multer from 'multer';
import { uploadBeforeEvidenceMiddleware } from '../../../core/config/cloudinary.config.js';
import {
    deleteBeforeEvidenceService,
    listBeforeEvidenceService,
    uploadBeforeEvidenceService
} from '../services/InspectionEvidence.service.js';

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
            envelope: {
                EM: 'Evidence image exceeds the configured size limit.',
                EC: 413,
                code: 'IMAGE_TOO_LARGE',
                DT: ''
            }
        };
    }
    if (error?.code === 'INVALID_IMAGE_TYPE') {
        return {
            status: 415,
            envelope: {
                EM: error.message,
                EC: 415,
                code: 'INVALID_IMAGE_TYPE',
                DT: ''
            }
        };
    }
    const isMulterError = error instanceof multer.MulterError;
    return {
        status: 400,
        envelope: {
            EM: isMulterError ? 'Invalid evidence multipart payload.' : 'Unable to process image upload.',
            EC: 400,
            code: 'INVALID_UPLOAD_PAYLOAD',
            DT: ''
        }
    };
};

const handleUploadBeforeEvidence = (req, res) => {
    uploadBeforeEvidenceMiddleware(req, res, async (multipartError) => {
        if (multipartError) {
            const mapped = mapMultipartError(multipartError);
            return res.status(mapped.status).json(mapped.envelope);
        }
        try {
            const result = await uploadBeforeEvidenceService(
                req.params.jobId,
                req.user.id,
                req.file
            );
            const successStatus = result.code === 'BEFORE_EVIDENCE_CREATED' ? 201 : 200;
            return res.status(getHttpStatus(result, successStatus)).json(result);
        } catch (error) {
            console.error('>>> Error in handleUploadBeforeEvidence:', error?.message || 'Unknown error');
            return res.status(500).json({
                EM: 'Internal server error.', EC: 500, code: 'INTERNAL_SERVER_ERROR', DT: ''
            });
        }
    });
};

const handleListBeforeEvidence = async (req, res) => {
    try {
        const result = await listBeforeEvidenceService(req.params.jobId, req.user);
        return res.status(getHttpStatus(result)).json(result);
    } catch (error) {
        console.error('>>> Error in handleListBeforeEvidence:', error?.message || 'Unknown error');
        return res.status(500).json({
            EM: 'Internal server error.', EC: 500, code: 'INTERNAL_SERVER_ERROR', DT: ''
        });
    }
};

const handleDeleteBeforeEvidence = async (req, res) => {
    try {
        const result = await deleteBeforeEvidenceService(
            req.params.jobId,
            req.params.evidenceId,
            req.user.id
        );
        return res.status(getHttpStatus(result)).json(result);
    } catch (error) {
        console.error('>>> Error in handleDeleteBeforeEvidence:', error?.message || 'Unknown error');
        return res.status(500).json({
            EM: 'Internal server error.', EC: 500, code: 'INTERNAL_SERVER_ERROR', DT: ''
        });
    }
};

export {
    handleDeleteBeforeEvidence,
    handleListBeforeEvidence,
    handleUploadBeforeEvidence
};
