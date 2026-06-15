import { createJobService, getCustomerJobsService } from '../services/CustomerJob.service.js';

const handleCreateJob = async (req, res) => {
    try {
        const userId = req.user.id;
        const { 
            service_id, issue_description, scheduled_at,
            province_code, ward_code, detail_address, service_address,
            gps_lat, gps_long, estimated_budget_min, estimated_budget_max
        } = req.body;

        if (!service_id || !issue_description || !service_address || !scheduled_at) {
            return res.status(400).json({
                EM: "Missing required fields: service_id, issue_description, service_address, or scheduled_at.",
                EC: 1,
                DT: ""
            });
        }

        const images = req.files ? req.files.map(file => file.path) : [];

        const result = await createJobService(userId, {
            service_id,
            issue_description,
            province_code,
            ward_code,
            detail_address,
            service_address,
            gps_lat,
            gps_long,
            estimated_budget_min,
            estimated_budget_max,
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

export { handleCreateJob, handleGetCustomerJobs };