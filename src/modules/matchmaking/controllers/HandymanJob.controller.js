import { getAvailableJobsForHandymanService } from '../services/HandymanJob.service.js';

const handleGetAvailableJobs = async (req, res) => {
    try {
        const handymanId = req.user.id;
        const { search, service_id, current_lat, current_long, sort_by } = req.query;
        const result = await getAvailableJobsForHandymanService(handymanId, {
            search: search ?? '',
            service_id: service_id ?? '',
            current_lat: current_lat ? parseFloat(current_lat) : null,
            current_long: current_long ? parseFloat(current_long) : null,
            sort_by: sort_by ?? ''
        });
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
