import Job from '../models/Job.model.js';
import Service from '../models/Service.model.js';
import User from '../../identity/models/User.model.js';
import JobStatusHistory from '../models/JobStatusHistory.model.js';
import Province from '../models/Province.model.js';
import Ward from '../models/Ward.model.js';
import UserAddress from '../../identity/models/UserAddress.model.js';
import db from '../../../core/database/connection.js';
import { reverseGeocodeService } from './Geocoding.service.js';
import { LOCATION_SOURCES, coordinatesMatch } from '../utils/location.util.js';

const createJobService = async (userId, jobData) => {
    const { 
        service_id, issue_description, scheduled_at, images,
        address_option, province_code, ward_code, detail_address, 
        gps_lat, gps_long, location_source, location_confirmed,
        estimated_budget_min, estimated_budget_max
    } = jobData;

    let trans;
    try {
        // Preflight reads and external geocoding happen before a database transaction is opened.
        const [user, service] = await Promise.all([
            User.findByPk(userId),
            Service.findByPk(service_id)
        ]);

        if (!user) {
            return { EM: "User not found.", EC: 404, DT: "" };
        }
        if (user.kyc_status !== 'VERIFIED') {
            return {
                EM: "Your account is not KYC verified. Please complete KYC verification to post jobs.",
                EC: 403,
                DT: ""
            };
        }
        if (!service) {
            return { EM: "Selected service does not exist.", EC: 404, DT: "" };
        }

        // Build the address snapshot without allowing geocoder output to overwrite local address data.
        let final_service_address = "";
        let final_province_code = null;
        let final_ward_code = null;
        let final_detail_address = null;
        const final_gps_lat = gps_lat ?? null;
        const final_gps_long = gps_long ?? null;
        let profileAddress = null;

        if (address_option === 1) {
            const normalizedDetailAddress = String(detail_address || '').trim();
            const [province, ward] = await Promise.all([
                Province.findOne({ where: { province_code } }),
                Ward.findOne({ where: { ward_code, province_code } })
            ]);

            if (!province) {
                return { EM: "Invalid province selected.", EC: 400, DT: "" };
            }
            if (!ward) {
                return { EM: "Invalid ward selected or ward does not belong to the selected province.", EC: 400, DT: "" };
            }

            final_province_code = province_code;
            final_ward_code = ward_code;
            final_detail_address = normalizedDetailAddress;
            final_service_address = `${normalizedDetailAddress}, ${ward.name}, ${province.name}`;
        } else if (address_option === 2) {
            profileAddress = await UserAddress.findOne({
                where: { user_id: userId, is_default: true }
            });

            if (!profileAddress) {
                return { EM: "No default address found in your profile. Please add one or use another option.", EC: 400, DT: "" };
            }
            if (
                location_source === LOCATION_SOURCES.PROFILE_ADDRESS
                && !coordinatesMatch(
                    final_gps_lat,
                    final_gps_long,
                    profileAddress.gps_lat,
                    profileAddress.gps_long
                )
            ) {
                return {
                    EM: "PROFILE_ADDRESS coordinates must match the saved profile coordinates. Use MANUAL_MAP_PIN after changing the pin.",
                    EC: 400,
                    DT: ""
                };
            }

            final_service_address = profileAddress.full_address;
            final_province_code = profileAddress.province_code;
            final_ward_code = profileAddress.ward_code;
            final_detail_address = profileAddress.detail_address;
        } else if (address_option === 3) {
            // Reverse geocoding is deliberately completed before opening the transaction.
            const reverseResult = await reverseGeocodeService({
                gpsLat: final_gps_lat,
                gpsLong: final_gps_long
            });
            final_service_address = reverseResult.EC === 0
                ? reverseResult.DT.service_address
                : 'Selected map location';
            // Option 3 did not use the authoritative local dropdowns, so codes stay null.
            final_province_code = null;
            final_ward_code = null;
            final_detail_address = null;
        }

        trans = await db.transaction();

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
            location_source,
            location_confirmed,
            location_confirmed_at: location_confirmed ? new Date() : null,
            estimated_budget_min: estimated_budget_min === undefined || estimated_budget_min === ''
                ? null
                : estimated_budget_min,
            estimated_budget_max: estimated_budget_max === undefined || estimated_budget_max === ''
                ? null
                : estimated_budget_max,
            scheduled_at,
            images: images || [],
            current_status: 'POSTED'
        }, { transaction: trans });

        let profileCoordinatesUpdated = false;
        if (address_option === 2 && final_gps_lat !== null && final_gps_long !== null) {
            const [updatedRows] = await UserAddress.update(
                { gps_lat: final_gps_lat, gps_long: final_gps_long },
                {
                    where: {
                        id: profileAddress.id,
                        user_id: userId,
                        is_default: true,
                        province_code: profileAddress.province_code,
                        ward_code: profileAddress.ward_code,
                        detail_address: profileAddress.detail_address
                    },
                    transaction: trans
                }
            );
            if (updatedRows !== 1) {
                throw new Error('Default profile address changed before coordinates could be saved.');
            }
            profileCoordinatesUpdated = true;
        }

        await JobStatusHistory.create({
            job_id: newJob.id,
            old_status: null,
            new_status: 'POSTED',
            changed_by_user_id: userId,
            trigger_gps_lat: final_gps_lat,
            trigger_gps_long: final_gps_long
        }, { transaction: trans });

        await trans.commit();
        const responseJob = newJob.toJSON();
        responseJob.profile_coordinates_updated = profileCoordinatesUpdated;
        return { 
          EM: "Job posted successfully!", 
          EC: 0, 
          DT: responseJob
        };

    } catch (error) {
        if (trans && !trans.finished) await trans.rollback();
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
                    attributes: ['id', 'full_name', 'avatar_url', 'phone_number'],
                    include: [
                        {
                            model: UserAddress,
                            attributes: [
                                'id', 'province_code', 'ward_code',
                                'detail_address', 'full_address', 'is_default'
                            ],
                            required: false
                        }
                    ]
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
