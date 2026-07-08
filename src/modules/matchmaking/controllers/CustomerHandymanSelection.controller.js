import {
    getPublicHandymanProfileService,
    compareBidsService
} from '../services/CustomerHandymanSelection.service.js';

const getHttpStatus = (errorCode) => {
    if (errorCode === 0) return 200;
    if ([400, 403, 404].includes(errorCode)) return errorCode;
    return 500;
};

const handleGetPublicHandymanProfile = async (req, res) => {
    try {
        const customerId = req.user.id;
        const { id: jobId, handymanId } = req.params;
        const result = await getPublicHandymanProfileService(customerId, jobId, handymanId);
        return res.status(getHttpStatus(result.EC)).json(result);
    } catch (error) {
        console.log(">>> Error in handleGetPublicHandymanProfile: ", error);
        return res.status(500).json({ EM: "Internal server error.", EC: 500, DT: "" });
    }
};

const handleCompareBids = async (req, res) => {
    try {
        const customerId = req.user.id;
        const result = await compareBidsService(customerId, req.body);
        return res.status(getHttpStatus(result.EC)).json(result);
    } catch (error) {
        console.log(">>> Error in handleCompareBids: ", error);
        return res.status(500).json({ EM: "Internal server error.", EC: 500, DT: "" });
    }
};

export {
    handleGetPublicHandymanProfile,
    handleCompareBids
};
