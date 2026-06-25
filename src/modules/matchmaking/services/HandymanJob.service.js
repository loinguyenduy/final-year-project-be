import Job from '../models/Job.model.js';
import Service from '../models/Service.model.js';
import Province from '../models/Province.model.js';
import Ward from '../models/Ward.model.js';
import HandymanService from '../models/HandymanService.model.js';
import HandymanServiceArea from '../models/HandymanServiceArea.model.js';
import HandymanProfile from '../../identity/models/HandymanProfile.model.js';
import User from '../../identity/models/User.model.js';
import { Op } from 'sequelize';
import db from '../../../core/database/connection.js';

// Haversine formula — returns distance in km between two GPS coordinates
const haversine = (lat1, lon1, lat2, lon2) => {
    const R = 6371;
    const toRad = x => (x * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return parseFloat((R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(2));
};

// Build a PostgreSQL literal for preferred_work_times filtering.
// Uses Vietnam timezone (UTC+7) for correct morning/afternoon/evening boundaries.
// Jobs with null scheduled_at (flexible) always pass through.
const buildWorkTimeCondition = (preferred_work_times) => {
    if (!preferred_work_times || preferred_work_times.length === 0) return null;

    const slots = [];
    if (preferred_work_times.includes('MORNING'))
        slots.push(`(EXTRACT(HOUR FROM "scheduled_at" AT TIME ZONE 'Asia/Ho_Chi_Minh') >= 6 AND EXTRACT(HOUR FROM "scheduled_at" AT TIME ZONE 'Asia/Ho_Chi_Minh') < 12)`);
    if (preferred_work_times.includes('AFTERNOON'))
        slots.push(`(EXTRACT(HOUR FROM "scheduled_at" AT TIME ZONE 'Asia/Ho_Chi_Minh') >= 12 AND EXTRACT(HOUR FROM "scheduled_at" AT TIME ZONE 'Asia/Ho_Chi_Minh') < 18)`);
    if (preferred_work_times.includes('EVENING'))
        slots.push(`(EXTRACT(HOUR FROM "scheduled_at" AT TIME ZONE 'Asia/Ho_Chi_Minh') >= 18 AND EXTRACT(HOUR FROM "scheduled_at" AT TIME ZONE 'Asia/Ho_Chi_Minh') < 22)`);
    if (preferred_work_times.includes('WEEKEND'))
        slots.push(`(EXTRACT(DOW FROM "scheduled_at" AT TIME ZONE 'Asia/Ho_Chi_Minh') IN (0, 6))`);

    if (slots.length === 0) return null;
    return db.literal(`("scheduled_at" IS NULL OR (${slots.join(' OR ')}))`);
};

const getAvailableJobsForHandymanService = async (handymanId, { search = '', service_id = '', current_lat = null, current_long = null } = {}) => {
    try {
        // Step 1: Fetch handyman profile data in parallel
        const [handymanServices, serviceAreas, handymanProfile] = await Promise.all([
            HandymanService.findAll({ where: { handyman_id: handymanId }, attributes: ['service_id'] }),
            HandymanServiceArea.findAll({ where: { handyman_id: handymanId }, attributes: ['province_code', 'ward_code'] }),
            HandymanProfile.findOne({ where: { user_id: handymanId }, attributes: ['preferred_work_times'] })
        ]);

        const serviceIds = handymanServices.map(s => s.service_id);
        const preferred_work_times = handymanProfile?.preferred_work_times ?? [];

        // Step 2: Build WHERE clause using Op.and to combine all filter criteria
        const andConditions = [
            { current_status: { [Op.in]: ['POSTED', 'BIDDING'] } }
        ];

        // Specialty/service filter — explicit service_id param overrides profile specialties
        if (service_id) {
            andConditions.push({ service_id });
        } else if (serviceIds.length > 0) {
            andConditions.push({ service_id: { [Op.in]: serviceIds } });
        }
        // If neither, no service filter — show all categories

        // Service area filter — province-level (ward_code null) covers entire province
        if (serviceAreas.length > 0) {
            andConditions.push({
                [Op.or]: serviceAreas.map(area =>
                    area.ward_code
                        ? { province_code: area.province_code, ward_code: area.ward_code }
                        : { province_code: area.province_code }
                )
            });
        }

        // Preferred work time filter
        const workTimeCondition = buildWorkTimeCondition(preferred_work_times);
        if (workTimeCondition) {
            andConditions.push(workTimeCondition);
        }

        // Step 3: Service include — optional name search
        const serviceInclude = {
            model: Service,
            attributes: ['id', 'name', 'service_code', 'icon_url']
        };
        if (search) {
            serviceInclude.where = { name: { [Op.iLike]: `%${search}%` } };
        }

        const jobs = await Job.findAll({
            where: { [Op.and]: andConditions },
            include: [
                serviceInclude,
                {
                    model: User,
                    as: 'Customer',
                    attributes: ['id', 'full_name', 'avatar_url']
                    // phone is intentionally excluded — revealed only at ACCEPTED+ in job detail
                },
                {
                    model: Province,
                    attributes: ['province_code', 'name', 'short_name'],
                    required: false
                },
                {
                    model: Ward,
                    attributes: ['ward_code', 'name'],
                    required: false
                }
            ],
            order: [['createdAt', 'DESC']]
        });

        // Step 4: Post-process each job — distance + mask sensitive fields
        const processed = jobs.map(job => {
            const data = job.toJSON();

            // Distance calculation (requires both parties to have GPS coordinates)
            if (current_lat != null && current_long != null && data.gps_lat != null && data.gps_long != null) {
                data.distance_km = haversine(current_lat, current_long, parseFloat(data.gps_lat), parseFloat(data.gps_long));
            } else {
                data.distance_km = null;
            }

            // Mask precise location for POSTED and BIDDING to prevent off-platform contact
            if (['POSTED', 'BIDDING'].includes(data.current_status)) {
                data.detail_address = null;
                const wardName = data.Ward?.name ?? '';
                const provinceName = data.Province?.name ?? '';
                data.service_address = [wardName, provinceName].filter(Boolean).join(', ');
            }

            return data;
        });

        // Step 5: Sort by distance ascending — jobs without GPS coordinates go to the end
        if (current_lat != null && current_long != null) {
            processed.sort((a, b) => {
                if (a.distance_km === null && b.distance_km === null) return 0;
                if (a.distance_km === null) return 1;
                if (b.distance_km === null) return -1;
                return a.distance_km - b.distance_km;
            });
        }

        return {
            EM: "Available jobs retrieved successfully.",
            EC: 0,
            DT: processed
        };
    } catch (error) {
        console.error(">>> Error in getAvailableJobsForHandymanService: ", error);
        return {
            EM: "Internal server error while retrieving available jobs.",
            EC: 500,
            DT: ""
        };
    }
};

export { getAvailableJobsForHandymanService };
