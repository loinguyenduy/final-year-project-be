import Job from '../models/Job.model.js';
import Service from '../models/Service.model.js';
import User from '../../identity/models/User.model.js';
import JobStatusHistory from '../models/JobStatusHistory.model.js';
import db from '../../../core/database/connection.js';

const createJobService = async (userId, jobData) => {
    const { 
        service_id, issue_description, scheduled_at, images,
        province_code, ward_code, detail_address, service_address, 
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

        // 3. Tạo bản ghi công việc mới (Job) với các thuộc tính nâng cấp
        const newJob = await Job.create({
            customer_id: userId,
            service_id,
            issue_description,
            province_code,
            ward_code,
            detail_address,
            service_address,
            gps_lat: gps_lat || null,
            gps_long: gps_long || null,
            estimated_budget_min: estimated_budget_min || null,
            estimated_budget_max: estimated_budget_max || null,
            scheduled_at,
            images: images || [],
            current_status: 'POSTED'
        }, { transaction: trans });

        // 4. Lưu vết lịch sử trạng thái đầu tiên
        await JobStatusHistory.create({
            job_id: newJob.id,
            old_status: null,
            new_status: 'POSTED',
            changed_by_user_id: userId,
            trigger_gps_lat: gps_lat || null,
            trigger_gps_long: gps_long || null
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