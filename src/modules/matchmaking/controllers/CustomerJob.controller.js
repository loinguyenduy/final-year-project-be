import {
    cancelPreAcceptanceJobService,
    createJobService,
    getCustomerJobsService,
    preflightEditableJobService,
    updatePostedJobService
} from '../services/CustomerJob.service.js';
import { validateJobLocationInput } from '../utils/location.util.js';
import { cleanupUploadedJobImages } from '../utils/jobImage.util.js';

const getHttpStatus = (result, successStatus = 200) => {
    if (result.EC === 0) return successStatus;
    return [400, 403, 404, 409, 413, 415].includes(result.EC) ? result.EC : 500;
};

const parseBoolean = (value) => {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return null;
};

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
        const result = await getCustomerJobsService(userId, req.query);
        return res.status(result.EC === 0 ? 200 : (result.EC === 400 ? 400 : 500)).json({
              EM: result.EM,
              EC: result.EC,
              code: result.code,
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

const handlePreflightEditJob = async (req, res, next) => {
    const result = await preflightEditableJobService(req.user.id, req.params.jobId);
    if (result.EC !== 0) return res.status(getHttpStatus(result)).json(result);
    return next();
};

const handleUpdatePostedJob = async (req, res) => {
    const uploadedFiles = req.files || [];
    try {
        let retainedImages;
        try {
            retainedImages = JSON.parse(req.body.retained_images || '[]');
        } catch {
            await cleanupUploadedJobImages(uploadedFiles, {
                job_id: req.params.jobId,
                operation: 'invalid_edit_payload'
            });
            return res.status(400).json({
                EM: 'retained_images must be valid JSON.',
                EC: 400,
                code: 'VALIDATION_ERROR',
                DT: ''
            });
        }

        const locationChanged = parseBoolean(req.body.location_changed);
        if (locationChanged === null) {
            await cleanupUploadedJobImages(uploadedFiles, {
                job_id: req.params.jobId,
                operation: 'invalid_edit_payload'
            });
            return res.status(400).json({
                EM: 'location_changed must be true or false.',
                EC: 400,
                code: 'VALIDATION_ERROR',
                DT: ''
            });
        }

        let locationValidation = null;
        let addressOption = null;
        if (locationChanged) {
            addressOption = Number(req.body.address_option);
            if (addressOption === 1
                && (!req.body.detail_address || !req.body.province_code || !req.body.ward_code)) {
                await cleanupUploadedJobImages(uploadedFiles, {
                    job_id: req.params.jobId,
                    operation: 'invalid_edit_location'
                });
                return res.status(400).json({
                    EM: 'detail_address, province_code and ward_code are required for option 1.',
                    EC: 400,
                    code: 'VALIDATION_ERROR',
                    DT: ''
                });
            }
            locationValidation = validateJobLocationInput({
                addressOption,
                gpsLat: req.body.gps_lat,
                gpsLong: req.body.gps_long,
                locationSource: req.body.location_source,
                locationConfirmed: req.body.location_confirmed
            });
            if (!locationValidation.valid) {
                await cleanupUploadedJobImages(uploadedFiles, {
                    job_id: req.params.jobId,
                    operation: 'invalid_edit_location'
                });
                return res.status(400).json({
                    EM: locationValidation.error,
                    EC: 400,
                    code: 'INVALID_JOB_LOCATION',
                    DT: ''
                });
            }
        }

        const result = await updatePostedJobService(
            req.user.id,
            req.params.jobId,
            {
                ...req.body,
                retained_images: retainedImages,
                location_changed: locationChanged,
                address_option: addressOption,
                gps_lat: locationValidation?.latitude ?? null,
                gps_long: locationValidation?.longitude ?? null,
                location_source: locationValidation?.locationSource ?? null,
                location_confirmed: locationValidation?.locationConfirmed ?? null
            },
            uploadedFiles
        );
        return res.status(getHttpStatus(result)).json(result);
    } catch (error) {
        await cleanupUploadedJobImages(uploadedFiles, {
            job_id: req.params.jobId,
            operation: 'edit_controller_error'
        });
        console.error('[matchmaking] Failed to handle Job edit.', {
            job_id: req.params.jobId,
            error: error?.message || 'Unknown error'
        });
        return res.status(500).json({
            EM: 'Internal server error.',
            EC: 500,
            code: 'INTERNAL_SERVER_ERROR',
            DT: ''
        });
    }
};

const handleCancelPreAcceptanceJob = async (req, res) => {
    try {
        const result = await cancelPreAcceptanceJobService(
            req.user.id,
            req.params.jobId,
            req.body
        );
        const successStatus = result.code === 'JOB_CANCELLED' ? 201 : 200;
        return res.status(getHttpStatus(result, successStatus)).json(result);
    } catch (error) {
        console.error('[matchmaking] Failed to handle pre-acceptance cancellation.', {
            job_id: req.params.jobId,
            error: error?.message || 'Unknown error'
        });
        return res.status(500).json({
            EM: 'Internal server error.',
            EC: 500,
            code: 'INTERNAL_SERVER_ERROR',
            DT: ''
        });
    }
};

export {
    handleCancelPreAcceptanceJob,
    handleCreateJob,
    handleGetCustomerJobs,
    handlePreflightEditJob,
    handleUpdatePostedJob
};
