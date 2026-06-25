import Job from '../models/Job.model.js';
import Service from '../models/Service.model.js';
import User from '../../identity/models/User.model.js';
import JobStatusHistory from '../models/JobStatusHistory.model.js';
import Province from '../models/Province.model.js';
import Ward from '../models/Ward.model.js';
import UserAddress from '../../identity/models/UserAddress.model.js';
import db from '../../../core/database/connection.js';
import { Op } from 'sequelize';

const createJobService = async (userId, jobData) => {
    const { 
        service_id, issue_description, scheduled_at, images,
        address_option, province_code, ward_code, detail_address, 
        gps_lat, gps_long, estimated_budget_min, estimated_budget_max 
    } = jobData;

    const trans = await db.transaction();
    try {
        // 1. Kiểm tra trạng thái KYC của Khách hàng
        const user = await User.findByPk(userId, { transaction: trans });
        if (!user) {
            await trans.rollback();
            return { EM: "User not found.", EC: 404, DT: "" };
        }

        if (user.kyc_status !== 'VERIFIED') {
            await trans.rollback();
            return {
                EM: "Your account is not KYC verified. Please complete KYC verification to post jobs.",
                EC: 403,
                DT: ""
            };
        }

        // 2. Kiểm tra danh mục dịch vụ tồn tại
        const service = await Service.findByPk(service_id, { transaction: trans });
        if (!service) {
            await trans.rollback();
            return { EM: "Selected service does not exist.", EC: 404, DT: "" };
        }

        // 3. Xử lý địa chỉ theo address_option
        let final_service_address = "";
        let final_province_code = province_code;
        let final_ward_code = ward_code;
        let final_detail_address = detail_address;
        let final_gps_lat = gps_lat || null;
        let final_gps_long = gps_long || null;

        if (address_option === 1) {
            // Validate ward belongs to province
            const province = await Province.findOne({ where: { province_code }, transaction: trans });
            const ward = await Ward.findOne({ where: { ward_code, province_code }, transaction: trans });

            if (!province) {
                await trans.rollback();
                return { EM: "Invalid province selected.", EC: 400, DT: "" };
            }
            if (!ward) {
                await trans.rollback();
                return { EM: "Invalid ward selected or ward does not belong to the selected province.", EC: 400, DT: "" };
            }
            
            final_service_address = `${detail_address}, ${ward.name}, ${province.name}`;
        } else if (address_option === 2) {
            // Lấy địa chỉ đã lưu trong profile (ưu tiên địa chỉ mặc định)
            let userAddress = await UserAddress.findOne({ where: { user_id: userId, is_default: true }, transaction: trans });
            if (!userAddress) {
                userAddress = await UserAddress.findOne({ where: { user_id: userId }, transaction: trans });
            }
            
            if (!userAddress) {
                await trans.rollback();
                return { EM: "No saved address found in your profile. Please add one or use another option.", EC: 400, DT: "" };
            }
            
            final_service_address = userAddress.full_address;
            final_province_code = userAddress.province_code;
            final_ward_code = userAddress.ward_code;
            final_detail_address = userAddress.detail_address;
            final_gps_lat = userAddress.gps_lat;
            final_gps_long = userAddress.gps_long;
        } else if (address_option === 3) {
            try {
                const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${gps_lat}&lon=${gps_long}&zoom=18&addressdetails=1`;
                const response = await fetch(url, {
                    headers: {
                        'User-Agent': 'FinalYearProjectBE/1.0',
                        'Accept-Language': 'vi'   // request Vietnamese names for reliable Province/Ward matching
                    }
                });
                const data = await response.json();

                if (data && data.address) {
                    const addr = data.address;

                    // Build human-readable address text
                    const parts = [];
                    if (addr.house_number) parts.push(addr.house_number);
                    if (addr.road) parts.push(addr.road);
                    if (addr.suburb) parts.push(addr.suburb);
                    if (addr.city_district) parts.push(addr.city_district);
                    if (addr.city || addr.state) parts.push(addr.city || addr.state);
                    final_service_address = parts.length > 0 ? parts.join(', ') : data.display_name;

                    // Resolve Province and Ward from Nominatim fields — best effort, non-blocking
                    // Province.short_name = "Hà Nội", Nominatim city = "Hà Nội" → direct match
                    // Ward.name = "Phường Ba Đình", Nominatim suburb = "Phường Ba Đình" → exact or partial match
                    try {
                        const cityName = addr.city || addr.state;
                        if (cityName) {
                            let province = await Province.findOne({
                                where: { short_name: cityName },
                                transaction: trans
                            });
                            if (!province) {
                                province = await Province.findOne({
                                    where: { name: { [Op.iLike]: `%${cityName}%` } },
                                    transaction: trans
                                });
                            }

                            if (province) {
                                final_province_code = province.province_code;

                                // Try suburb first (phường/xã level), then city_district as fallback
                                const wardCandidates = [addr.suburb, addr.city_district].filter(Boolean);
                                for (const candidate of wardCandidates) {
                                    let ward = await Ward.findOne({
                                        where: { name: candidate, province_code: province.province_code },
                                        transaction: trans
                                    });
                                    if (!ward) {
                                        ward = await Ward.findOne({
                                            where: {
                                                province_code: province.province_code,
                                                name: { [Op.iLike]: `%${candidate}%` }
                                            },
                                            transaction: trans
                                        });
                                    }
                                    if (ward) {
                                        final_ward_code = ward.ward_code;
                                        break;
                                    }
                                }
                            }
                        }
                    } catch (geoMatchErr) {
                        // Non-critical — job creation continues even if province/ward lookup fails
                        console.warn('Province/Ward lookup from GPS failed:', geoMatchErr.message);
                    }
                } else {
                    final_service_address = "Unknown Location";
                }
            } catch (err) {
                console.error("Geocoding error:", err);
                await trans.rollback();
                return { EM: "Failed to get address from GPS coordinates.", EC: 500, DT: "" };
            }
        }

        // 4. Tạo bản ghi công việc mới (Job) với các thuộc tính nâng cấp
        const newJob = await Job.create({
            customer_id: userId,
            service_id,
            issue_description,
            province_code: final_province_code,
            ward_code: final_ward_code,
            detail_address: final_detail_address,
            service_address: final_service_address,
            gps_lat: final_gps_lat,
            gps_long: final_gps_long,
            estimated_budget_min: estimated_budget_min || null,
            estimated_budget_max: estimated_budget_max || null,
            scheduled_at,
            images: images || [],
            current_status: 'POSTED'
        }, { transaction: trans });

        // 5. Lưu vết lịch sử trạng thái đầu tiên
        await JobStatusHistory.create({
            job_id: newJob.id,
            old_status: null,
            new_status: 'POSTED',
            changed_by_user_id: userId,
            trigger_gps_lat: final_gps_lat,
            trigger_gps_long: final_gps_long
        }, { transaction: trans });

        await trans.commit();
        return { 
          EM: "Job posted successfully!", 
          EC: 0, 
          DT: newJob 
        };

    } catch (error) {
        await trans.rollback();
        console.log(">>> Error in createJobService: ", error);
        return { 
          EM: "Internal server error while posting job.", 
          EC: 500, 
          DT: "" 
        };
    }
};

const getCustomerJobsService = async (userId) => {
    try {
        const jobs = await Job.findAll({
            where: { customer_id: userId },
            include: [
                {
                    model: Service,
                    attributes: ['id', 'name', 'service_code', 'icon_url']
                },
                {
                    model: User,
                    as: 'SelectedHandyman',
                    attributes: ['id', 'full_name', 'avatar_url', 'phone_number']
                }
            ],
            order: [['createdAt', 'DESC']]
        });
        return { 
          EM: "Customer jobs retrieved successfully.", 
          EC: 0, 
          DT: jobs 
        };
    } catch (error) {
        console.log(">>> Error in getCustomerJobsService: ", error);
        return { 
          EM: "Internal server error while retrieving customer jobs.", 
          EC: 500, 
          DT: "" 
        };
    }
};

export { createJobService, getCustomerJobsService };