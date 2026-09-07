import { getServicesCategoryService, getJobDetailsByIdService } from "../services/Job.service.js";
import { parseCoordinatePair } from '../utils/location.util.js';

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
        const requestingUser = req.user ? { id: req.user.id, role: req.user.role } : null;
        const { current_lat, current_long } = req.query;
        const coordinates = parseCoordinatePair(current_lat, current_long);
        if (!coordinates.valid) {
            return res.status(400).json({ EM: coordinates.error, EC: 400, DT: '' });
        }
        const result = await getJobDetailsByIdService(jobId, requestingUser, {
            current_lat: coordinates.latitude,
            current_long: coordinates.longitude
        });
        const status = result.EC === 0
            ? 200
            : ([403, 404].includes(result.EC) ? result.EC : 500);
        return res.status(status).json({
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
