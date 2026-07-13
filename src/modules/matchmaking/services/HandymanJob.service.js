import Job from '../models/Job.model.js';
import Service from '../models/Service.model.js';
import Province from '../models/Province.model.js';
import Ward from '../models/Ward.model.js';
import HandymanService from '../models/HandymanService.model.js';
import HandymanServiceArea from '../models/HandymanServiceArea.model.js';
import HandymanProfile from '../../identity/models/HandymanProfile.model.js';
import User from '../../identity/models/User.model.js';
import Bid from '../models/Bid.model.js';
import { Op } from 'sequelize';
import db from '../../../core/database/connection.js';

// Haversine formula — returns distance in km
const haversine = (lat1, lon1, lat2, lon2) => {
    const R = 6371;
    const toRad = x => (x * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return parseFloat((R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(2));
};

// Work time check in Vietnam timezone (UTC+7)
// Returns true if the job's scheduled time falls in any of the handyman's preferred slots.
// Jobs with null scheduled_at (flexible timing) always pass.
const matchesWorkTime = (scheduledAt, preferred_work_times) => {
    if (!scheduledAt) return true;
    if (!preferred_work_times || preferred_work_times.length === 0) return true;

    // toLocaleString converts the UTC timestamp to Vietnam local time
    const vnDateStr = new Date(scheduledAt).toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' });
    const vnDate = new Date(vnDateStr);
    const hour = vnDate.getHours();
    const dow = vnDate.getDay(); // 0 = Sunday, 6 = Saturday

    if (preferred_work_times.includes('MORNING') && hour >= 6 && hour < 12) return true;
    if (preferred_work_times.includes('AFTERNOON') && hour >= 12 && hour < 18) return true;
    if (preferred_work_times.includes('EVENING') && hour >= 18 && hour < 22) return true;
    if (preferred_work_times.includes('WEEKEND') && (dow === 0 || dow === 6)) return true;

    return false;
};

const getAvailableJobsForHandymanService = async (handymanId, {
    search = '',
    service_id = '',
    current_lat = null,
    current_long = null,
    sort_by = ''
} = {}) => {
    try {
        // Step 1: Fetch handyman profile data in parallel
        const [handymanServices, serviceAreas, handymanProfile, cancelledBidRows] = await Promise.all([
            HandymanService.findAll({ where: { handyman_id: handymanId }, attributes: ['service_id'] }),
            HandymanServiceArea.findAll({ where: { handyman_id: handymanId }, attributes: ['province_code', 'ward_code'] }),
            HandymanProfile.findOne({ where: { user_id: handymanId }, attributes: ['preferred_work_times'] }),
            Bid.findAll({
                where: {
                    handyman_id: handymanId,
                    status: 'CANCELLED_BY_HANDYMAN'
                },
                attributes: ['job_id'],
                raw: true
            })
        ]);

        const serviceIds = handymanServices.map(s => s.service_id);
        const preferred_work_times = handymanProfile?.preferred_work_times ?? [];
        const cancelledJobIds = [
            ...new Set(cancelledBidRows.map((bid) => bid.job_id).filter(Boolean))
        ];

        // Step 2: Build SQL WHERE clause
        const andConditions = [
            { current_status: { [Op.in]: ['POSTED', 'BIDDING'] } }
        ];

        if (cancelledJobIds.length > 0) {
            andConditions.push({ id: { [Op.notIn]: cancelledJobIds } });
        }

        // Specialty filter — explicit service_id param overrides profile specialties
        if (service_id) {
            andConditions.push({ service_id });
        } else if (serviceIds.length > 0) {
            andConditions.push({ service_id: { [Op.in]: serviceIds } });
        }

        // Service area filter
        // Jobs with province_code = null (posted via GPS without manual province selection)
        // are always included since their location cannot be determined for filtering.
        if (serviceAreas.length > 0) {
            const areaOrConditions = [
                { province_code: null },
                ...serviceAreas.map(area =>
                    area.ward_code
                        ? { province_code: area.province_code, ward_code: area.ward_code }
                        : { province_code: area.province_code }
                )
            ];
            andConditions.push({ [Op.or]: areaOrConditions });
        }

        // Step 3: Fetch matching jobs
        const jobs = await Job.findAll({
            where: { [Op.and]: andConditions },
            attributes: {
                include: [
                    [
                        db.literal(`(SELECT COUNT(*) FROM "Bids" WHERE "Bids"."job_id" = "Job"."id" AND "Bids"."status" = 'PENDING')`),
                        'active_bid_count'
                    ]
                ]
            },
            include: [
                {
                    model: Service,
                    attributes: ['id', 'name', 'service_code', 'icon_url']
                },
                {
                    model: User,
                    as: 'Customer',
                    attributes: [
                        'id', 'full_name', 'avatar_url', 'kyc_status',
                        [
                            db.literal(`(SELECT COALESCE(ROUND(AVG(r.rating_stars::numeric), 1), 0) FROM "Reviews" r WHERE r.reviewee_id = "Customer"."id")`),
                            'avg_rating'
                        ]
                    ]
                    // phone_number intentionally excluded — revealed at ACCEPTED+ in job detail only
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

        // Step 4: Post-process — distance, work time filter (JS), address masking, search
        const searchLower = search.toLowerCase();

        const processed = jobs
            .map(job => {
                const data = job.toJSON();

                // Distance
                if (current_lat != null && current_long != null && data.gps_lat != null && data.gps_long != null) {
                    data.distance_km = haversine(current_lat, current_long, parseFloat(data.gps_lat), parseFloat(data.gps_long));
                } else {
                    data.distance_km = null;
                }

                // Mask precise location for POSTED/BIDDING to prevent off-platform contact
                if (['POSTED', 'BIDDING'].includes(data.current_status)) {
                    data.detail_address = null;
                    data.gps_lat = null;
                    data.gps_long = null;
                    const wardName = data.Ward?.name ?? '';
                    const provinceName = data.Province?.name ?? '';
                    data.service_address = [wardName, provinceName].filter(Boolean).join(', ');
                }

                return data;
            })
            // Work time filter in JS (reliable, avoids db.literal timezone complexities)
            .filter(data => matchesWorkTime(data.scheduled_at, preferred_work_times))
            // Search: across issue description and service name
            .filter(data => {
                if (!search) return true;
                const matchesDesc = data.issue_description?.toLowerCase().includes(searchLower);
                const matchesService = data.Service?.name?.toLowerCase().includes(searchLower);
                return matchesDesc || matchesService;
            });

        // Step 5: Sort
        const hasGPS = current_lat != null && current_long != null;
        const effectiveSortBy = sort_by || (hasGPS ? 'distance' : 'newest');

        processed.sort((a, b) => {
            switch (effectiveSortBy) {
                case 'distance':
                    if (a.distance_km === null && b.distance_km === null) return 0;
                    if (a.distance_km === null) return 1;
                    if (b.distance_km === null) return -1;
                    return a.distance_km - b.distance_km;
                case 'budget_desc':
                    return (parseFloat(b.estimated_budget_max) || 0) - (parseFloat(a.estimated_budget_max) || 0);
                case 'budget_asc':
                    return (parseFloat(a.estimated_budget_max) || 0) - (parseFloat(b.estimated_budget_max) || 0);
                case 'scheduled_asc':
                    if (!a.scheduled_at && !b.scheduled_at) return 0;
                    if (!a.scheduled_at) return 1;
                    if (!b.scheduled_at) return -1;
                    return new Date(a.scheduled_at) - new Date(b.scheduled_at);
                case 'newest':
                default:
                    return new Date(b.createdAt) - new Date(a.createdAt);
            }
        });

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
