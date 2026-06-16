import { getServicesCategoryService, getJobDetailsByIdService } from "../services/Job.service.js";

const handleGetServices = async (req, res) => {
    try {
        const result = await getServicesCategoryService();
        return res.status(result.EC === 0 ? 200 : 500).json({
            EM: result.EM,
            EC: result.EC,
            DT: result.DT
        });
    } catch (error) {
        console.log(">>> Error in handleGetServices controller: ", error);
        return res.status(500).json({
            EM: "Internal server error.",
            EC: 500,
            DT: ""
        });
    }
};

const handleGetJobDetails = async (req, res) => {
    try {
        const jobId = req.params.id;
        const result = await getJobDetailsByIdService(jobId);
        return res.status(result.EC === 0 ? 200 : (result.EC === 404 ? 404 : 500)).json({
            EM: result.EM,
            EC: result.EC,
            DT: result.DT
        });
    } catch (error) {
        console.log(">>> Error in handleGetJobDetails controller: ", error);
        return res.status(500).json({
            EM: "Internal server error.",
            EC: 500,
            DT: ""
        });
    }
};

export { handleGetServices, handleGetJobDetails };
