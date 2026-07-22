import { Op } from 'sequelize';
import User from '../models/User.model.js';
import HandymanProfile from '../models/HandymanProfile.model.js';
import UserAddress from '../models/UserAddress.model.js';
import Wallet from '../../fintech/models/Wallet.model.js';
import AuthProvider from '../models/AuthProvider.model.js';
import KycRequest from '../models/KycRequest.model.js';
import Service from '../../matchmaking/models/Service.model.js';
import Province from '../../matchmaking/models/Province.model.js';
import Ward from '../../matchmaking/models/Ward.model.js';
import HandymanService from '../../matchmaking/models/HandymanService.model.js';
import HandymanServiceArea from '../../matchmaking/models/HandymanServiceArea.model.js';
import { KYC_REJECTION_MESSAGES } from '../constants/kyc.constants.js';
import { getCanonicalProfile } from './ParticipantRead.service.js';

const VALID_WORK_TIMES = ['MORNING', 'AFTERNOON', 'EVENING', 'WEEKEND'];

// ─── GET PROFILE ─────────────────────────────────────────────────────────────

const getDetailedProfileService = async (userId) => {
    try {
        const profile = await getCanonicalProfile(userId);
        if (!profile) {
            return { EM: "User profile not found.", EC: 404, DT: "" };
        }
        return { EM: "Fetch user profile successfully.", EC: 0, DT: profile };

    } catch (error) {
        console.error(">>> Error in getDetailedProfileService: ", error);
        return { EM: "Internal server error while fetching profile.", EC: 500, DT: "" };
    }
};

// ─── SECTION 1: ADDRESS ──────────────────────────────────────────────────────

const updateUserAddressService = async (userId, { province_code, ward_code, detail_address }) => {
    try {
        const province = await Province.findOne({ where: { province_code } });
        if (!province) {
            return { EM: "Province not found.", EC: 404, DT: "" };
        }

        const ward = await Ward.findOne({ where: { ward_code, province_code } });
        if (!ward) {
            return { EM: "Ward not found or does not belong to the given province.", EC: 404, DT: "" };
        }

        const full_address = `${detail_address}, ${ward.name}, ${province.name}`;

        const existing = await UserAddress.findOne({ where: { user_id: userId, is_default: true } });

        let result;
        if (existing) {
            await existing.update({
                province_code,
                ward_code,
                detail_address,
                full_address,
                gps_lat: null,
                gps_long: null
            });
            result = existing;
        } else {
            result = await UserAddress.create({
                user_id: userId,
                province_code,
                ward_code,
                detail_address,
                full_address,
                is_default: true
            });
        }

        return { EM: "Address updated successfully.", EC: 0, DT: result };

    } catch (error) {
        console.error(">>> Error in updateUserAddressService: ", error);
        return { EM: "Internal server error while updating address.", EC: 500, DT: "" };
    }
};

// ─── SECTION 2: BIO ──────────────────────────────────────────────────────────

const updateHandymanBioService = async (userId, bio) => {
    try {
        const [rowsUpdated, [updated]] = await HandymanProfile.update(
            { bio },
            { where: { user_id: userId }, returning: true }
        );

        if (rowsUpdated === 0) {
            return { EM: "Handyman profile not found.", EC: 404, DT: "" };
        }

        return { EM: "Bio updated successfully.", EC: 0, DT: updated };

    } catch (error) {
        console.error(">>> Error in updateHandymanBioService: ", error);
        return { EM: "Internal server error while updating bio.", EC: 500, DT: "" };
    }
};

// ─── SECTION 2: SERVICES (CHUYÊN MÔN) ───────────────────────────────────────

const getHandymanServicesService = async (userId) => {
    try {
        const services = await HandymanService.findAll({
            where: { handyman_id: userId },
            include: [{ model: Service, attributes: ['id', 'name', 'icon_url', 'service_code'] }]
        });

        return { EM: "Fetch handyman services successfully.", EC: 0, DT: services };

    } catch (error) {
        console.error(">>> Error in getHandymanServicesService: ", error);
        return { EM: "Internal server error while fetching services.", EC: 500, DT: "" };
    }
};

const addHandymanServiceService = async (userId, serviceId) => {
    try {
        const service = await Service.findOne({ where: { id: serviceId, is_active: true } });
        if (!service) {
            return { EM: "Service not found or inactive.", EC: 404, DT: "" };
        }

        const existing = await HandymanService.findOne({ where: { handyman_id: userId, service_id: serviceId } });
        if (existing) {
            return { EM: "This service is already in your profile.", EC: 400, DT: "" };
        }

        const record = await HandymanService.create({ handyman_id: userId, service_id: serviceId });

        const result = await HandymanService.findByPk(record.id, {
            include: [{ model: Service, attributes: ['id', 'name', 'icon_url', 'service_code'] }]
        });

        return { EM: "Service added successfully.", EC: 0, DT: result };

    } catch (error) {
        console.error(">>> Error in addHandymanServiceService: ", error);
        return { EM: "Internal server error while adding service.", EC: 500, DT: "" };
    }
};

const removeHandymanServiceService = async (userId, serviceId) => {
    try {
        const record = await HandymanService.findOne({ where: { handyman_id: userId, service_id: serviceId } });
        if (!record) {
            return { EM: "Service not found in your profile.", EC: 404, DT: "" };
        }

        await record.destroy();

        return { EM: "Service removed successfully.", EC: 0, DT: "" };

    } catch (error) {
        console.error(">>> Error in removeHandymanServiceService: ", error);
        return { EM: "Internal server error while removing service.", EC: 500, DT: "" };
    }
};

// ─── SECTION 3: SERVICE AREAS (KHU VỰC PHỤC VỤ) ─────────────────────────────

const getHandymanServiceAreasService = async (userId) => {
    try {
        const areas = await HandymanServiceArea.findAll({
            where: { handyman_id: userId },
            include: [
                { model: Province, attributes: ['province_code', 'name', 'short_name'] },
                { model: Ward, attributes: ['ward_code', 'name'], required: false }
            ]
        });

        return { EM: "Fetch handyman service areas successfully.", EC: 0, DT: areas };

    } catch (error) {
        console.error(">>> Error in getHandymanServiceAreasService: ", error);
        return { EM: "Internal server error while fetching service areas.", EC: 500, DT: "" };
    }
};

const addHandymanServiceAreaService = async (userId, { province_code, ward_code }) => {
    try {
        const province = await Province.findOne({ where: { province_code } });
        if (!province) {
            return { EM: "Province not found.", EC: 404, DT: "" };
        }

        if (ward_code) {
            const ward = await Ward.findOne({ where: { ward_code, province_code } });
            if (!ward) {
                return { EM: "Ward not found or does not belong to the given province.", EC: 404, DT: "" };
            }
        }

        const existing = await HandymanServiceArea.findOne({
            where: {
                handyman_id: userId,
                province_code,
                ward_code: ward_code ? ward_code : { [Op.is]: null }
            }
        });
        if (existing) {
            return { EM: "This area is already in your profile.", EC: 400, DT: "" };
        }

        const record = await HandymanServiceArea.create({
            handyman_id: userId,
            province_code,
            ward_code: ward_code || null
        });

        const result = await HandymanServiceArea.findByPk(record.id, {
            include: [
                { model: Province, attributes: ['province_code', 'name', 'short_name'] },
                { model: Ward, attributes: ['ward_code', 'name'], required: false }
            ]
        });

        return { EM: "Service area added successfully.", EC: 0, DT: result };

    } catch (error) {
        console.error(">>> Error in addHandymanServiceAreaService: ", error);
        return { EM: "Internal server error while adding service area.", EC: 500, DT: "" };
    }
};

const removeHandymanServiceAreaService = async (userId, areaId) => {
    try {
        const record = await HandymanServiceArea.findOne({ where: { id: areaId, handyman_id: userId } });
        if (!record) {
            return { EM: "Service area not found in your profile.", EC: 404, DT: "" };
        }

        await record.destroy();

        return { EM: "Service area removed successfully.", EC: 0, DT: "" };

    } catch (error) {
        console.error(">>> Error in removeHandymanServiceAreaService: ", error);
        return { EM: "Internal server error while removing service area.", EC: 500, DT: "" };
    }
};

// ─── SECTION 4: WORK TIMES (GIỜ LÀM VIỆC) ───────────────────────────────────

const updateHandymanWorkTimesService = async (userId, preferred_work_times) => {
    try {
        const invalid = preferred_work_times.filter(t => !VALID_WORK_TIMES.includes(t));
        if (invalid.length > 0) {
            return {
                EM: `Invalid work time values: ${invalid.join(', ')}. Valid values: ${VALID_WORK_TIMES.join(', ')}.`,
                EC: 400,
                DT: ""
            };
        }

        const [rowsUpdated, [updated]] = await HandymanProfile.update(
            { preferred_work_times },
            { where: { user_id: userId }, returning: true }
        );

        if (rowsUpdated === 0) {
            return { EM: "Handyman profile not found.", EC: 404, DT: "" };
        }

        return { EM: "Work times updated successfully.", EC: 0, DT: updated };

    } catch (error) {
        console.error(">>> Error in updateHandymanWorkTimesService: ", error);
        return { EM: "Internal server error while updating work times.", EC: 500, DT: "" };
    }
};

export {
    getDetailedProfileService,
    updateUserAddressService,
    updateHandymanBioService,
    getHandymanServicesService,
    addHandymanServiceService,
    removeHandymanServiceService,
    getHandymanServiceAreasService,
    addHandymanServiceAreaService,
    removeHandymanServiceAreaService,
    updateHandymanWorkTimesService
};
