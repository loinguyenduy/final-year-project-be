import Job from '../models/Job.model.js';
import Service from '../models/Service.model.js';
import User from '../../identity/models/User.model.js';
import JobStatusHistory from '../models/JobStatusHistory.model.js';
import Bid from '../models/Bid.model.js';

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

const getJobDetailsByIdService = async (jobId) => {
    try {
        const job = await Job.findOne({
            where: { id: jobId },
            include: [
                {
                    model: Service,
                    attributes: ['id', 'name', 'service_code', 'icon_url']
                },
                {
                    model: User,
                    as: 'Customer',
                    attributes: ['id', 'full_name', 'avatar_url', 'phone_number']
                },
                {
                    model: User,
                    as: 'SelectedHandyman',
                    attributes: ['id', 'full_name', 'avatar_url', 'phone_number']
                },
                {
                    model: JobStatusHistory,
                    include: [
                        {
                            model: User,
                            attributes: ['id', 'full_name', 'role']
                        }
                    ]
                },
                {
                    model: Bid,
                    attributes: ['id', 'proposed_price', 'message', 'status', 'handyman_id']
                }
            ],
            order: [
                [JobStatusHistory, 'createdAt', 'DESC']
            ]
        });

        if (!job) {
            return { EM: "Job not found.", EC: 404, DT: "" };
        }

        return {
            EM: "Job details retrieved successfully.",
            EC: 0,
            DT: job
        };
    } catch (error) {
        console.log(">>> Error in getJobDetailsByIdService: ", error);
        return {
            EM: "Internal server error while retrieving job details.",
            EC: 500,
            DT: ""
        };
    }
};

export { getServicesCategoryService, getJobDetailsByIdService };
