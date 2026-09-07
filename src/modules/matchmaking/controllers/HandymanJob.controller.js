import { getAvailableJobsForHandymanService } from '../services/HandymanJob.service.js';
import { parseCoordinatePair } from '../utils/location.util.js';

const handleGetAvailableJobs = async (req, res) => {
    try {
        const handymanId = req.user.id;
        const { search, service_id, current_lat, current_long, sort_by } = req.query;
        const coordinates = parseCoordinatePair(current_lat, current_long);
        if (!coordinates.valid) {
            return res.status(400).json({ EM: coordinates.error, EC: 400, DT: '' });
        }
        const result = await getAvailableJobsForHandymanService(handymanId, {
            search: search ?? '',
            service_id: service_id ?? '',
            current_lat: coordinates.latitude,
            current_long: coordinates.longitude,
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
