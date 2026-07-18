import {
    cancelByCustomerService,
    cancelByHandymanService
} from '../services/AcceptedCancellation.service.js';

const getHttpStatus = (result) => {
    if (result.EC === 0) return 200;
    return [400, 401, 403, 404, 409].includes(result.EC) ? result.EC : 500;
};

const handleCancelByCustomer = async (req, res) => {
    try {
        const result = await cancelByCustomerService(req.params.id, req.user.id, req.body);
        return res.status(getHttpStatus(result)).json(result);
    } catch (error) {
        console.error('>>> Error in handleCancelByCustomer:', error);
        return res.status(500).json({
            EM: 'Internal server error.',
            EC: 500,
            code: 'INTERNAL_SERVER_ERROR',
            DT: ''
        });
    }
};

const handleCancelByHandyman = async (req, res) => {
    try {
        const result = await cancelByHandymanService(req.params.id, req.user.id, req.body);
        return res.status(getHttpStatus(result)).json(result);
    } catch (error) {
        console.error('>>> Error in handleCancelByHandyman:', error);
        return res.status(500).json({
            EM: 'Internal server error.',
            EC: 500,
            code: 'INTERNAL_SERVER_ERROR',
            DT: ''
        });
    }
};

export { handleCancelByCustomer, handleCancelByHandyman };
