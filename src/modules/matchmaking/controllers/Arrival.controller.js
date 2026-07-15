import {
    confirmArrivalService,
    rejectArrivalService,
    requestArrivalService
} from '../services/Arrival.service.js';

const getHttpStatus = (result, successStatus = 200) => {
    if (result.EC === 0) return successStatus;
    return [400, 401, 403, 404, 409].includes(result.EC) ? result.EC : 500;
};

const handleRequestArrival = async (req, res) => {
    try {
        const result = await requestArrivalService(req.params.id, req.user.id, req.body);
        const successStatus = result.code === 'ARRIVAL_REQUEST_CREATED' ? 201 : 200;
        return res.status(getHttpStatus(result, successStatus)).json(result);
    } catch (error) {
        console.error('>>> Error in handleRequestArrival:', error?.message || 'Unknown error');
        return res.status(500).json({
            EM: 'Internal server error.',
            EC: 500,
            code: 'INTERNAL_SERVER_ERROR',
            DT: ''
        });
    }
};

const handleConfirmArrival = async (req, res) => {
    try {
        const result = await confirmArrivalService(
            req.params.id,
            req.params.requestId,
            req.user.id
        );
        return res.status(getHttpStatus(result)).json(result);
    } catch (error) {
        console.error('>>> Error in handleConfirmArrival:', error?.message || 'Unknown error');
        return res.status(500).json({
            EM: 'Internal server error.',
            EC: 500,
            code: 'INTERNAL_SERVER_ERROR',
            DT: ''
        });
    }
};

const handleRejectArrival = async (req, res) => {
    try {
        const result = await rejectArrivalService(
            req.params.id,
            req.params.requestId,
            req.user.id,
            req.body
        );
        return res.status(getHttpStatus(result)).json(result);
    } catch (error) {
        console.error('>>> Error in handleRejectArrival:', error?.message || 'Unknown error');
        return res.status(500).json({
            EM: 'Internal server error.',
            EC: 500,
            code: 'INTERNAL_SERVER_ERROR',
            DT: ''
        });
    }
};

export {
    handleConfirmArrival,
    handleRejectArrival,
    handleRequestArrival
};
