import Province from '../models/Province.model.js';
import Ward from '../models/Ward.model.js';
import Service from '../models/Service.model.js'; 

const getProvincesService = async () => {
    try {
        const provinces = await Province.findAll({
            order: [['name', 'ASC']]
        });
        return {
            EM: "Provinces list retrieved successfully.",
            EC: 0,
            DT: provinces
        };
    } catch (error) {
        console.log(">>> Error in getProvincesService: ", error);
        return {
            EM: "Internal server error while retrieving provinces.",
            EC: 500,
            DT: []
        };
    }
};

const getWardsByProvinceService = async (provinceCode) => {
    try {
        const wards = await Ward.findAll({
            where: { province_code: provinceCode },
            order: [['name', 'ASC']]
        });
        return {
            EM: "Wards list retrieved successfully.",
            EC: 0,
            DT: wards
        };
    } catch (error) {
        console.log(">>> Error in getWardsByProvinceService: ", error);
        return {
            EM: "Internal server error while retrieving wards.",
            EC: 500,
            DT: []
        };
    }
};

const getServicesCategoryService = async () => {
    try {
        const services = await Service.findAll({
            where: { is_active: true },
            order: [['name', 'ASC']]
        });
        return {
            EM: "Services list retrieved successfully.",
            EC: 0,
            DT: services
        };
    } catch (error) {
        console.log(">>> Error in getServicesCategoryService: ", error);
        return {
            EM: "Internal server error while retrieving services.",
            EC: 500,
            DT: []
        };
    }
};

export { getProvincesService, getWardsByProvinceService, getServicesCategoryService };