import {
    getContractService,
    getPaymentSummaryService,
    payRemainingAmountService
} from '../services/QuotePayment.service.js';

const getHttpStatus = (result) => {
    if (result.EC === 0) return 200;
    return [400, 401, 403, 404, 409].includes(result.EC) ? result.EC : 500;
};

const internalError = (res) => res.status(500).json({
    EM: 'Internal server error.',
    EC: 500,
    code: 'INTERNAL_SERVER_ERROR',
    DT: ''
});

const handlePayRemainingAmount = async (req, res) => {
    try {
        const result = await payRemainingAmountService(req.params.jobId, req.user, req.body);
        return res.status(getHttpStatus(result)).json(result);
    } catch (error) {
        console.error('>>> Error in handlePayRemainingAmount:', error?.message || 'Unknown error');
        return internalError(res);
    }
};

const handleGetPaymentSummary = async (req, res) => {
    try {
        const result = await getPaymentSummaryService(req.params.jobId, req.user);
        return res.status(getHttpStatus(result)).json(result);
    } catch (error) {
        console.error('>>> Error in handleGetPaymentSummary:', error?.message || 'Unknown error');
        return internalError(res);
    }
};

const handleGetContract = async (req, res) => {
    try {
        const result = await getContractService(req.params.jobId, req.user);
        return res.status(getHttpStatus(result)).json(result);
    } catch (error) {
        console.error('>>> Error in handleGetContract:', error?.message || 'Unknown error');
        return internalError(res);
    }
};

export {
    handleGetContract,
    handleGetPaymentSummary,
    handlePayRemainingAmount
};
