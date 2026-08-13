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
import { calculateDistanceKm } from '../utils/location.util.js';
import { getRatingSummaries } from '../../dispute/services/Rating.service.js';
import JobAiPriceSuggestion from '../../ai/models/JobAiPriceSuggestion.model.js';
import {
    SAFE_GUIDANCE_ATTRIBUTES,
    buildSafeAiPriceGuidance
} from '../../ai/services/AiJobIntegration.service.js';

// Hàm này lọc các công việc dựa trên thời gian làm việc ưu tiên của thợ sửa chữa. 
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

// Hàm lấy danh sách các công việc có sẵn cho một thợ sửa chữa cụ thể, 
// dựa trên các tiêu chí như dịch vụ, khu vực, thời gian làm việc và tìm kiếm.
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

        // Lọc theo dịch vụ: nếu service_id được cung cấp, chỉ lấy công việc với service_id đó;
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

        // Step 3: Hiển thị các công việc dựa trên các điều kiện đã xây dựng, bao gồm cả thông tin liên quan đến dịch vụ, 
        // khách hàng, khu vực và gợi ý giá AI (nếu có).
        const jobs = await Job.findAll({
            where: { [Op.and]: andConditions },
            attributes: {
                exclude: ['en_route_gps_lat', 'en_route_gps_long'],
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
                    attributes: ['id', 'full_name', 'avatar_url', 'kyc_status']
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
                },
                {
                    model: JobAiPriceSuggestion,
                    as: 'AiPriceSuggestion',
                    attributes: SAFE_GUIDANCE_ATTRIBUTES,
                    required: false
                }
            ],
            order: [['createdAt', 'DESC']]
        });

        // Step 4: Xu lý dữ liệu job để thêm thông tin khoảng cách, 
        // ẩn thông tin nhạy cảm và lọc theo thời gian làm việc ưu tiên cũng như từ khóa tìm kiếm.
        const searchLower = search.toLowerCase();

        const processed = jobs
            .map(job => {
                const data = job.toJSON();
                const safeAiGuidance = buildSafeAiPriceGuidance(data.AiPriceSuggestion);
                delete data.AiPriceSuggestion;
                if (safeAiGuidance) data.ai_price_guidance = safeAiGuidance;

                // Distance: tính toán khoảng cách từ vị trí hiện tại của thợ sửa chữa đến vị trí công việc (nếu có GPS)
                if (current_lat != null && current_long != null && data.gps_lat != null && data.gps_long != null) {
                    data.distance_km = calculateDistanceKm(
                        current_lat,
                        current_long,
                        parseFloat(data.gps_lat),
                        parseFloat(data.gps_long)
                    );
                } else {
                    data.distance_km = null;
                }

                // nếu công việc đang ở trạng thái POSTED hoặc BIDDING, ẩn thông tin địa chỉ chi tiết và GPS để bảo vệ 
                // quyền riêng tư của khách hàng.
                if (['POSTED', 'BIDDING'].includes(data.current_status)) {
                    data.detail_address = null;
                    data.gps_lat = null;
                    data.gps_long = null;
                    data.location_source = null;
                    data.location_confirmed = null;
                    data.location_confirmed_at = null;
                    const wardName = data.Ward?.name ?? '';
                    const provinceName = data.Province?.name ?? '';
                    data.service_address = [wardName, provinceName].filter(Boolean).join(', ');
                }

                return data;
            })
            // Filter: loại bỏ các công việc không phù hợp với thời gian làm việc ưu tiên của thợ sửa chữa
            .filter(data => matchesWorkTime(data.scheduled_at, preferred_work_times))
            // Filter: loại bỏ các công việc không phù hợp với từ khóa tìm kiếm (mô tả công việc hoặc tên dịch vụ)
            .filter(data => {
                if (!search) return true;
                const matchesDesc = data.issue_description?.toLowerCase().includes(searchLower);
                const matchesService = data.Service?.name?.toLowerCase().includes(searchLower);
                return matchesDesc || matchesService;
            });

        const customerIds = [...new Set(processed.map((entry) => entry.Customer?.id).filter(Boolean))];
        const customerRatings = await getRatingSummaries(customerIds.map((id) => ({ id, role: 'CUSTOMER' })));
        processed.forEach((entry) => {
            if (entry.Customer?.id) entry.Customer.rating_summary = customerRatings.get(entry.Customer.id);
        });

        // Step 5: Sort
        const hasGPS = current_lat != null && current_long != null;
        const effectiveSortBy = sort_by || (hasGPS ? 'distance' : 'newest');

        processed.sort((a, b) => {
            switch (effectiveSortBy) {
                case 'distance':
                    // Nếu job không có GPS, đặt nó ở cuối danh sách. Nếu cả hai đều không có GPS, sắp xếp theo ngày tạo.
                    if (a.distance_km === null && b.distance_km === null) {
                        return new Date(b.createdAt) - new Date(a.createdAt);
                    }
                    // Nếu chỉ một trong hai job không có GPS, đặt job đó ở cuối danh sách.
                    if (a.distance_km === null) return 1;
                    if (b.distance_km === null) return -1;
                    
                    return (a.distance_km - b.distance_km)
                        || (new Date(b.createdAt) - new Date(a.createdAt));
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
