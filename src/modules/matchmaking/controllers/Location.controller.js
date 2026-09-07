import { getProvincesService, getWardsByProvinceService } from '../services/Location.service.js';
import { geocodeAddressService, reverseGeocodeService } from '../services/Geocoding.service.js';

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

const handleGeocodeAddress = async (req, res) => {
    try {
        const { province_code, ward_code, detail_address } = req.body;
        const result = await geocodeAddressService({
            provinceCode: province_code,
            wardCode: ward_code,
            detailAddress: detail_address
        });
        return res.status(result.EC === 0 ? 200 : result.EC).json(result);
    } catch (error) {
        console.error('>>> Error in handleGeocodeAddress:', error?.message || error);
        return res.status(500).json({
            EM: 'Internal server error while geocoding address.',
            EC: 500,
            DT: ''
        });
    }
};

const handleReverseGeocode = async (req, res) => {
    try {
        const { gps_lat, gps_long } = req.body;
        const result = await reverseGeocodeService({ gpsLat: gps_lat, gpsLong: gps_long });
        return res.status(result.EC === 0 ? 200 : result.EC).json(result);
    } catch (error) {
        console.error('>>> Error in handleReverseGeocode:', error?.message || error);
        return res.status(500).json({
            EM: 'Internal server error while reverse geocoding location.',
            EC: 500,
            DT: ''
        });
    }
};

export {
    handleGetProvinces,
    handleGetWards,
    handleGeocodeAddress,
    handleReverseGeocode
};
