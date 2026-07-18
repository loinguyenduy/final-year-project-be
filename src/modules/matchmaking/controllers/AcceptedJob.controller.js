import {
    getAcceptedDetailsService,
    startMovingService
} from '../services/AcceptedJob.service.js';

const getHttpStatus = (result, successStatus = 200) => {
    if (result.EC === 0) return successStatus;
    return [400, 401, 403, 404, 409].includes(result.EC) ? result.EC : 500;
};

const handleGetAcceptedDetails = async (req, res) => {
    try {
        const result = await getAcceptedDetailsService(req.params.id, req.user);
        return res.status(getHttpStatus(result)).json(result);
    } catch (error) {
        console.error('>>> Error in handleGetAcceptedDetails:', error);
        return res.status(500).json({
            EM: 'Internal server error.',
            EC: 500,
            code: 'INTERNAL_SERVER_ERROR',
            DT: ''
        });
    }
};

const handleStartMoving = async (req, res) => {
    try {
        const result = await startMovingService(req.params.id, req.user.id, req.body);
        return res.status(getHttpStatus(result)).json(result);
    } catch (error) {
        console.error('>>> Error in handleStartMoving:', error);
        return res.status(500).json({
            EM: 'Internal server error.',
            EC: 500,
            code: 'INTERNAL_SERVER_ERROR',
            DT: ''
        });
    }
};

export { handleGetAcceptedDetails, handleStartMoving };
