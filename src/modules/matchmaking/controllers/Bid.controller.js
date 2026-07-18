import {
    submitBidService,
    updateBidService,
    withdrawBidService,
    getMyBidsService
} from '../services/Bid.service.js';

const handleSubmitBid = async (req, res) => {
    try {
        const handymanId = req.user.id;
        const jobId = req.params.id;
        const result = await submitBidService(handymanId, jobId, req.body);
        const status = result.EC === 0
            ? (result.HTTP_STATUS || 201)
            : ([403, 404, 409].includes(result.EC) ? result.EC : 400);
        const { HTTP_STATUS, ...responseBody } = result;
        return res.status(status).json(responseBody);
    } catch (error) {
        console.log(">>> Error in handleSubmitBid: ", error);
        return res.status(500).json({ EM: "Internal server error.", EC: 500, DT: "" });
    }
};

const handleUpdateBid = async (req, res) => {
    try {
        const handymanId = req.user.id;
        const { id: jobId, bidId } = req.params;
        const result = await updateBidService(handymanId, jobId, bidId, req.body);
        const status = result.EC === 0
            ? 200
            : ([404, 409].includes(result.EC) ? result.EC : 400);
        return res.status(status).json(result);
    } catch (error) {
        console.log(">>> Error in handleUpdateBid: ", error);
        return res.status(500).json({ EM: "Internal server error.", EC: 500, DT: "" });
    }
};

const handleWithdrawBid = async (req, res) => {
    try {
        const handymanId = req.user.id;
        const { id: jobId, bidId } = req.params;
        const result = await withdrawBidService(handymanId, jobId, bidId);
        const status = result.EC === 0
            ? 200
            : ([404, 409].includes(result.EC) ? result.EC : 400);
        return res.status(status).json(result);
    } catch (error) {
        console.log(">>> Error in handleWithdrawBid: ", error);
        return res.status(500).json({ EM: "Internal server error.", EC: 500, DT: "" });
    }
};

const handleGetMyBids = async (req, res) => {
    try {
        const handymanId = req.user.id;
        const result = await getMyBidsService(handymanId);
        return res.status(result.EC === 0 ? 200 : 500).json(result);
    } catch (error) {
        console.log(">>> Error in handleGetMyBids: ", error);
        return res.status(500).json({ EM: "Internal server error.", EC: 500, DT: [] });
    }
};

export { handleSubmitBid, handleUpdateBid, handleWithdrawBid, handleGetMyBids };
