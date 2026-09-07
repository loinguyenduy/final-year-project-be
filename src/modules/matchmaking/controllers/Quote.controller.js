import {
    createOrGetQuoteDraftService,
    getCurrentQuoteService,
    submitQuoteService,
    updateQuoteDraftService
} from '../services/Quote.service.js';
import {
    acceptQuoteService,
    rejectQuoteService
} from '../services/QuoteResponse.service.js';

const getHttpStatus = (result, successStatus = 200) => {
    if (result.EC === 0) return successStatus;
    return [400, 401, 403, 404, 409, 413, 415, 502].includes(result.EC)
        ? result.EC
        : 500;
};

const handleCreateOrGetQuoteDraft = async (req, res) => {
    try {
        const result = await createOrGetQuoteDraftService(req.params.jobId, req.user.id);
        const successStatus = result.code === 'QUOTE_DRAFT_CREATED' ? 201 : 200;
        return res.status(getHttpStatus(result, successStatus)).json(result);
    } catch (error) {
        console.error('>>> Error in handleCreateOrGetQuoteDraft:', error?.message || 'Unknown error');
        return res.status(500).json({
            EM: 'Internal server error.', EC: 500, code: 'INTERNAL_SERVER_ERROR', DT: ''
        });
    }
};

const handleUpdateQuoteDraft = async (req, res) => {
    try {
        const result = await updateQuoteDraftService(
            req.params.jobId,
            req.params.quoteId,
            req.user.id,
            req.body
        );
        return res.status(getHttpStatus(result)).json(result);
    } catch (error) {
        console.error('>>> Error in handleUpdateQuoteDraft:', error?.message || 'Unknown error');
        return res.status(500).json({
            EM: 'Internal server error.', EC: 500, code: 'INTERNAL_SERVER_ERROR', DT: ''
        });
    }
};

const handleSubmitQuote = async (req, res) => {
    try {
        const result = await submitQuoteService(
            req.params.jobId,
            req.params.quoteId,
            req.user.id,
            req.body
        );
        return res.status(getHttpStatus(result)).json(result);
    } catch (error) {
        console.error('>>> Error in handleSubmitQuote:', error?.message || 'Unknown error');
        return res.status(500).json({
            EM: 'Internal server error.', EC: 500, code: 'INTERNAL_SERVER_ERROR', DT: ''
        });
    }
};

const handleGetCurrentQuote = async (req, res) => {
    try {
        const result = await getCurrentQuoteService(req.params.jobId, req.user);
        return res.status(getHttpStatus(result)).json(result);
    } catch (error) {
        console.error('>>> Error in handleGetCurrentQuote:', error?.message || 'Unknown error');
        return res.status(500).json({
            EM: 'Internal server error.', EC: 500, code: 'INTERNAL_SERVER_ERROR', DT: ''
        });
    }
};

const handleAcceptQuote = async (req, res) => {
    try {
        const result = await acceptQuoteService(
            req.params.jobId,
            req.params.quoteId,
            req.user,
            req.body
        );
        return res.status(getHttpStatus(result)).json(result);
    } catch (error) {
        console.error('>>> Error in handleAcceptQuote:', error?.message || 'Unknown error');
        return res.status(500).json({
            EM: 'Internal server error.', EC: 500, code: 'INTERNAL_SERVER_ERROR', DT: ''
        });
    }
};

const handleRejectQuote = async (req, res) => {
    try {
        const result = await rejectQuoteService(
            req.params.jobId,
            req.params.quoteId,
            req.user,
            req.body
        );
        const successStatus = result.code === 'QUOTE_REJECTED' ? 201 : 200;
        return res.status(getHttpStatus(result, successStatus)).json(result);
    } catch (error) {
        console.error('>>> Error in handleRejectQuote:', error?.message || 'Unknown error');
        return res.status(500).json({
            EM: 'Internal server error.', EC: 500, code: 'INTERNAL_SERVER_ERROR', DT: ''
        });
    }
};

export {
    handleAcceptQuote,
    handleCreateOrGetQuoteDraft,
    handleGetCurrentQuote,
    handleRejectQuote,
    handleSubmitQuote,
    handleUpdateQuoteDraft
};
