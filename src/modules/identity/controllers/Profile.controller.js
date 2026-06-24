import {
    getDetailedProfileService,
    updateHandymanAddressService,
    updateHandymanBioService,
    getHandymanServicesService,
    addHandymanServiceService,
    removeHandymanServiceService,
    getHandymanServiceAreasService,
    addHandymanServiceAreaService,
    removeHandymanServiceAreaService,
    updateHandymanWorkTimesService
} from "../services/Profile.service.js";

const handleGetUserProfile = async (req, res) => {
    try {
        const userId = req.user.id;
        const result = await getDetailedProfileService(userId);
        return res.status(result.EC === 0 ? 200 : result.EC).json({
            EM: result.EM, EC: result.EC, DT: result.DT
        });
    } catch (error) {
        console.error(">>> Error in handleGetUserProfile: ", error);
        return res.status(500).json({ EM: "Internal server error.", EC: 500, DT: "" });
    }
};

// Section 1 — Address
const handleUpdateHandymanAddress = async (req, res) => {
    try {
        const userId = req.user.id;
        const { province_code, ward_code, detail_address } = req.body;

        if (!province_code || !ward_code || !detail_address) {
            return res.status(400).json({
                EM: "Missing required fields: province_code, ward_code, detail_address.",
                EC: 400, DT: ""
            });
        }

        const result = await updateHandymanAddressService(userId, { province_code, ward_code, detail_address });
        return res.status(result.EC === 0 ? 200 : result.EC).json({
            EM: result.EM, EC: result.EC, DT: result.DT
        });
    } catch (error) {
        console.error(">>> Error in handleUpdateHandymanAddress: ", error);
        return res.status(500).json({ EM: "Internal server error.", EC: 500, DT: "" });
    }
};

// Section 2 — Bio
const handleUpdateHandymanBio = async (req, res) => {
    try {
        const userId = req.user.id;
        const { bio } = req.body;

        if (!bio || bio.trim() === '') {
            return res.status(400).json({ EM: "Bio cannot be empty.", EC: 400, DT: "" });
        }

        const result = await updateHandymanBioService(userId, bio.trim());
        return res.status(result.EC === 0 ? 200 : result.EC).json({
            EM: result.EM, EC: result.EC, DT: result.DT
        });
    } catch (error) {
        console.error(">>> Error in handleUpdateHandymanBio: ", error);
        return res.status(500).json({ EM: "Internal server error.", EC: 500, DT: "" });
    }
};

// Section 2 — Services
const handleGetHandymanServices = async (req, res) => {
    try {
        const userId = req.user.id;
        const result = await getHandymanServicesService(userId);
        return res.status(result.EC === 0 ? 200 : result.EC).json({
            EM: result.EM, EC: result.EC, DT: result.DT
        });
    } catch (error) {
        console.error(">>> Error in handleGetHandymanServices: ", error);
        return res.status(500).json({ EM: "Internal server error.", EC: 500, DT: "" });
    }
};

const handleAddHandymanService = async (req, res) => {
    try {
        const userId = req.user.id;
        const { service_id } = req.body;

        if (!service_id) {
            return res.status(400).json({ EM: "service_id is required.", EC: 400, DT: "" });
        }

        const result = await addHandymanServiceService(userId, service_id);
        return res.status(result.EC === 0 ? 201 : result.EC).json({
            EM: result.EM, EC: result.EC, DT: result.DT
        });
    } catch (error) {
        console.error(">>> Error in handleAddHandymanService: ", error);
        return res.status(500).json({ EM: "Internal server error.", EC: 500, DT: "" });
    }
};

const handleRemoveHandymanService = async (req, res) => {
    try {
        const userId = req.user.id;
        const { service_id } = req.params;

        const result = await removeHandymanServiceService(userId, service_id);
        return res.status(result.EC === 0 ? 200 : result.EC).json({
            EM: result.EM, EC: result.EC, DT: result.DT
        });
    } catch (error) {
        console.error(">>> Error in handleRemoveHandymanService: ", error);
        return res.status(500).json({ EM: "Internal server error.", EC: 500, DT: "" });
    }
};

// Section 3 — Service Areas
const handleGetHandymanServiceAreas = async (req, res) => {
    try {
        const userId = req.user.id;
        const result = await getHandymanServiceAreasService(userId);
        return res.status(result.EC === 0 ? 200 : result.EC).json({
            EM: result.EM, EC: result.EC, DT: result.DT
        });
    } catch (error) {
        console.error(">>> Error in handleGetHandymanServiceAreas: ", error);
        return res.status(500).json({ EM: "Internal server error.", EC: 500, DT: "" });
    }
};

const handleAddHandymanServiceArea = async (req, res) => {
    try {
        const userId = req.user.id;
        const { province_code, ward_code } = req.body;

        if (!province_code) {
            return res.status(400).json({ EM: "province_code is required.", EC: 400, DT: "" });
        }

        const result = await addHandymanServiceAreaService(userId, { province_code, ward_code });
        return res.status(result.EC === 0 ? 201 : result.EC).json({
            EM: result.EM, EC: result.EC, DT: result.DT
        });
    } catch (error) {
        console.error(">>> Error in handleAddHandymanServiceArea: ", error);
        return res.status(500).json({ EM: "Internal server error.", EC: 500, DT: "" });
    }
};

const handleRemoveHandymanServiceArea = async (req, res) => {
    try {
        const userId = req.user.id;
        const { area_id } = req.params;

        const result = await removeHandymanServiceAreaService(userId, area_id);
        return res.status(result.EC === 0 ? 200 : result.EC).json({
            EM: result.EM, EC: result.EC, DT: result.DT
        });
    } catch (error) {
        console.error(">>> Error in handleRemoveHandymanServiceArea: ", error);
        return res.status(500).json({ EM: "Internal server error.", EC: 500, DT: "" });
    }
};

// Section 4 — Work Times
const handleUpdateHandymanWorkTimes = async (req, res) => {
    try {
        const userId = req.user.id;
        const { preferred_work_times } = req.body;

        if (!Array.isArray(preferred_work_times)) {
            return res.status(400).json({ EM: "preferred_work_times must be an array.", EC: 400, DT: "" });
        }

        const result = await updateHandymanWorkTimesService(userId, preferred_work_times);
        return res.status(result.EC === 0 ? 200 : result.EC).json({
            EM: result.EM, EC: result.EC, DT: result.DT
        });
    } catch (error) {
        console.error(">>> Error in handleUpdateHandymanWorkTimes: ", error);
        return res.status(500).json({ EM: "Internal server error.", EC: 500, DT: "" });
    }
};

export {
    handleGetUserProfile,
    handleUpdateHandymanAddress,
    handleUpdateHandymanBio,
    handleGetHandymanServices,
    handleAddHandymanService,
    handleRemoveHandymanService,
    handleGetHandymanServiceAreas,
    handleAddHandymanServiceArea,
    handleRemoveHandymanServiceArea,
    handleUpdateHandymanWorkTimes
};
