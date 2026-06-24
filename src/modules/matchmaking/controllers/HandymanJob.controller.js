import { getAvailableJobsForHandymanService } from '../services/HandymanJob.service.js';

const handleGetAvailableJobs = async (req, res) => {
    try {
        const { search, service_id } = req.query;
        const result = await getAvailableJobsForHandymanService(search, service_id);
        return res.status(result.EC === 0 ? 200 : 500).json({
            EM: result.EM,
            EC: result.EC,
            DT: result.DT
        });
    } catch (error) {
        console.log(">>> Error in handleGetAvailableJobs controller: ", error);
        return res.status(500).json({ EM: "Internal server error.", EC: 500, DT: "" });
    }
};

export { handleGetAvailableJobs };