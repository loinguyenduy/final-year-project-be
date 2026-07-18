import {
    confirmCancellationService,
    createCancellationService,
    getCurrentCancellationService,
    rejectCancellationService
} from '../services/LifecycleCancellation.service.js';

const errorStatus = (result) => {
    if (result.EC === 0) return 200;
    return [400, 401, 403, 404, 409].includes(result.EC) ? result.EC : 500;
};

const handleCreateCancellation = async (req, res) => {
    try {
        const result = await createCancellationService(req.params.jobId, req.user, req.body);
        const createdCodes = new Set([
            'CANCELLATION_RESOLVED',
            'CANCELLATION_AWAITING_COUNTERPARTY',
            'CANCELLATION_REVIEW_REQUIRED'
        ]);
        const status = result.EC === 0 && createdCodes.has(result.code)
            ? 201
            : errorStatus(result);
        return res.status(status).json(result);
    } catch (error) {
        console.error('>>> Error in handleCreateCancellation:', error);
        return res.status(500).json({
            EM: 'Internal server error.',
            EC: 500,
            code: 'INTERNAL_SERVER_ERROR',
            DT: ''
        });
    }
};

const handleGetCurrentCancellation = async (req, res) => {
    try {
        const result = await getCurrentCancellationService(req.params.jobId, req.user);
        return res.status(errorStatus(result)).json(result);
    } catch (error) {
        console.error('>>> Error in handleGetCurrentCancellation:', error);
        return res.status(500).json({
            EM: 'Internal server error.',
            EC: 500,
            code: 'INTERNAL_SERVER_ERROR',
            DT: ''
        });
    }
};

const handleConfirmCancellation = async (req, res) => {
    try {
        const result = await confirmCancellationService(
            req.params.jobId,
            req.params.cancellationId,
            req.user,
            req.body || {}
        );
        return res.status(errorStatus(result)).json(result);
    } catch (error) {
        console.error('>>> Error in handleConfirmCancellation:', error);
        return res.status(500).json({
            EM: 'Internal server error.',
            EC: 500,
            code: 'INTERNAL_SERVER_ERROR',
            DT: ''
        });
    }
};

const handleRejectCancellation = async (req, res) => {
    try {
        const result = await rejectCancellationService(
            req.params.jobId,
            req.params.cancellationId,
            req.user,
            req.body
        );
        return res.status(errorStatus(result)).json(result);
    } catch (error) {
        console.error('>>> Error in handleRejectCancellation:', error);
        return res.status(500).json({
            EM: 'Internal server error.',
            EC: 500,
            code: 'INTERNAL_SERVER_ERROR',
            DT: ''
        });
    }
};

export {
    handleConfirmCancellation,
    handleCreateCancellation,
    handleGetCurrentCancellation,
    handleRejectCancellation
};
