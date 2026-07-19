import {
    confirmCompletionSettlementService,
    createCompletionRequestService,
    getCompletionRequestEvidenceService,
    listCompletionRequestsService,
    rejectCompletionRequestService
} from '../services/CompletionRequest.service.js';

const getHttpStatus = (result, successStatus = 200) => {
    if (result.EC === 0) return successStatus;
    return [400, 401, 403, 404, 409].includes(result.EC) ? result.EC : 500;
};

const sendInternalError = (res, error, operation) => {
    console.error(`[completion] ${operation} failed.`, error);
    return res.status(500).json({ EM: 'Internal server error.', EC: 500, code: 'INTERNAL_SERVER_ERROR', DT: '' });
};

const handleCreateCompletionRequest = async (req, res) => {
    try {
        const result = await createCompletionRequestService(req.params.jobId, req.user.id, req.body);
        const created = result.code === 'COMPLETION_REQUEST_CREATED';
        return res.status(getHttpStatus(result, created ? 201 : 200)).json(result);
    } catch (error) {
        return sendInternalError(res, error, 'Create Completion Request');
    }
};

const handleListCompletionRequests = async (req, res) => {
    try {
        const result = await listCompletionRequestsService(req.params.jobId, req.user);
        return res.status(getHttpStatus(result)).json(result);
    } catch (error) {
        return sendInternalError(res, error, 'List Completion Requests');
    }
};

const handleGetCompletionRequestEvidence = async (req, res) => {
    try {
        const result = await getCompletionRequestEvidenceService(
            req.params.jobId,
            req.params.requestId,
            req.user
        );
        return res.status(getHttpStatus(result)).json(result);
    } catch (error) {
        return sendInternalError(res, error, 'Get Completion Evidence');
    }
};

const handleConfirmCompletionRequest = async (req, res) => {
    try {
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
            || Object.keys(req.body).length > 0) {
            return res.status(400).json({
                EM: 'Confirm Completion body must be an empty JSON object.',
                EC: 400,
                code: 'VALIDATION_ERROR',
                DT: ''
            });
        }
        const result = await confirmCompletionSettlementService(
            req.params.jobId,
            req.params.requestId,
            req.user
        );
        return res.status(getHttpStatus(result)).json(result);
    } catch (error) {
        return sendInternalError(res, error, 'Confirm Completion Request');
    }
};

const handleRejectCompletionRequest = async (req, res) => {
    try {
        const result = await rejectCompletionRequestService(
            req.params.jobId,
            req.params.requestId,
            req.user,
            req.body
        );
        return res.status(getHttpStatus(result)).json(result);
    } catch (error) {
        return sendInternalError(res, error, 'Reject Completion Request');
    }
};

export {
    handleConfirmCompletionRequest,
    handleCreateCompletionRequest,
    handleGetCompletionRequestEvidence,
    handleListCompletionRequests,
    handleRejectCompletionRequest
};
