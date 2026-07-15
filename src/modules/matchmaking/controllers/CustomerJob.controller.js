import { createJobService, getCustomerJobsService } from '../services/CustomerJob.service.js';
import { validateJobLocationInput } from '../utils/location.util.js';

const handleCreateJob = async (req, res) => {
    try {
        const userId = req.user.id;
        const { 
            service_id, issue_description, scheduled_at,
            address_option, province_code, ward_code, detail_address,
            gps_lat, gps_long, location_source, location_confirmed,
            estimated_budget_min, estimated_budget_max
        } = req.body;

        if (!service_id || !issue_description || !scheduled_at || !address_option) {
            return res.status(400).json({
                EM: "Missing required fields: service_id, issue_description, scheduled_at, or address_option.",
                EC: 400,
                DT: ""
            });
        }

        // Validate budget
        if (estimated_budget_min !== undefined && estimated_budget_max !== undefined) {
            if (Number(estimated_budget_min) < 0) {
                return res.status(400).json({ EM: "Minimum budget cannot be negative.", EC: 400, DT: "" });
            }
            if (Number(estimated_budget_min) > Number(estimated_budget_max)) {
                return res.status(400).json({ EM: "Minimum budget cannot be greater than maximum budget.", EC: 400, DT: "" });
            }
        }

        // Validate address option
        const parsedAddressOption = Number(address_option);
        
        if (parsedAddressOption === 1 && (!detail_address || !province_code || !ward_code)) {
            return res.status(400).json({ EM: "Missing detail_address, province_code or ward_code for option 1.", EC: 400, DT: "" });
        } else if (parsedAddressOption === 2) {
            // No extra fields needed, will fetch from User profile
        } else if (![1, 2, 3].includes(parsedAddressOption)) {
            return res.status(400).json({ EM: "Invalid address_option. Must be 1, 2, or 3.", EC: 400, DT: "" });
        }

        const locationValidation = validateJobLocationInput({
            addressOption: parsedAddressOption,
            gpsLat: gps_lat,
            gpsLong: gps_long,
            locationSource: location_source,
            locationConfirmed: location_confirmed
        });
        if (!locationValidation.valid) {
            return res.status(400).json({ EM: locationValidation.error, EC: 400, DT: "" });
        }

        const images = req.files ? req.files.map(file => file.path) : [];

        const result = await createJobService(userId, {
            service_id,
            issue_description,
            address_option: Number(address_option),
            province_code,
            ward_code,
            detail_address,
            gps_lat: locationValidation.latitude,
            gps_long: locationValidation.longitude,
            location_source: locationValidation.locationSource,
            location_confirmed: locationValidation.locationConfirmed,
            estimated_budget_min,
            estimated_budget_max,
            scheduled_at,
            images

        });

        const responseStatus = result.EC === 0 ? 200 : result.EC;
        return res.status(responseStatus).json({
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
