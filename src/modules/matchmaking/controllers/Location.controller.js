import { getProvincesService, getWardsByProvinceService } from '../services/Location.service.js';

const handleGetProvinces = async (req, res) => {
    try {
        const result = await getProvincesService();
        return res.status(result.EC === 0 ? 200 : 500).json({
            EM: result.EM,
            EC: result.EC,
            DT: result.DT
        });
    } catch (error) {
        return res.status(500).json({ 
          EM: "Internal server error.", 
          EC: 500, 
          DT: "" 
        });
    }
};

const handleGetWards = async (req, res) => {
    try {
        const { province_code } = req.query;
        if (!province_code) {
            return res.status(400).json({
                EM: "Missing required query parameter: province_code",
                EC: 1,
                DT: ""
            });
        }
        const result = await getWardsByProvinceService(province_code);
        return res.status(result.EC === 0 ? 200 : 500).json({
            EM: result.EM,
            EC: result.EC,
            DT: result.DT
        });
    } catch (error) {
        return res.status(500).json({ 
          EM: "Internal server error.", 
          EC: 500, 
          DT: "" 
        });
    }
};

export { handleGetProvinces, handleGetWards };