import { createJobService, getServicesService, getCustomerJobsService, getAvailableJobsForHandymanService } from "../services/Job.service.js";

const handleCreateJob = async (req, res) => {
    try {
        const userId = req.user.id;
        const { service_id, issue_description, service_address, gps_lat, gps_long, scheduled_at } = req.body;

        // Basic validations
        if (!service_id || !issue_description || !service_address || !scheduled_at) {
            return res.status(400).json({
                EM: "Missing required fields: service_id, issue_description, service_address, or scheduled_at.",
                EC: 1,
                DT: ""
            });
        }

        // Get uploaded file paths from Cloudinary (req.files is populated by Multer array middleware)
        const images = req.files ? req.files.map(file => file.path) : [];

        const result = await createJobService(userId, {
            service_id,
            issue_description,
            service_address,
            gps_lat,
            gps_long,
            scheduled_at,
            images
        });

        return res.status(result.EC === 0 ? 200 : 500).json({
            EM: result.EM,
            EC: result.EC,
            DT: result.DT
        });

    } catch (error) {
        console.log(">>> Error in handleCreateJob controller: ", error);
        return res.status(500).json({
            EM: "Internal server error.",
            EC: 500,
            DT: ""
        });
    }
};

const handleGetServices = async (req, res) => {
    try {
        const result = await getServicesService();
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

const handleGetCustomerJobs = async (req, res) => {
    try {
        const userId = req.user.id;
        const result = await getCustomerJobsService(userId);
        return res.status(result.EC === 0 ? 200 : 500).json({
            EM: result.EM,
            EC: result.EC,
            DT: result.DT
        });
    } catch (error) {
        console.log(">>> Error in handleGetCustomerJobs controller: ", error);
        return res.status(500).json({
            EM: "Internal server error.",
            EC: 500,
            DT: ""
        });
    }
};

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
        return res.status(500).json({
            EM: "Internal server error.",
            EC: 500,
            DT: ""
        });
    }
};

export { handleCreateJob, handleGetServices, handleGetCustomerJobs, handleGetAvailableJobs };
