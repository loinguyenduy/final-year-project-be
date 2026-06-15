import Job from '../models/Job.model.js';
import Service from '../models/Service.model.js';
import { Op } from 'sequelize';

const getAvailableJobsForHandymanService = async (search = '', service_id = '') => {
    try {
        let whereCondition = { current_status: 'POSTED' };

        if (service_id) {
            whereCondition.service_id = service_id;
        }

        let includeServiceOptions = {
            model: Service,
            attributes: ['id', 'name', 'service_code', 'icon_url']
        };

        if (search) {
            includeServiceOptions.where = {
                name: { [Op.iLike]: `%${search}%` }
            };
        }

        const jobs = await Job.findAll({
            where: whereCondition,
            include: [includeServiceOptions],
            order: [['createdAt', 'DESC']]
        });
        
        return { 
          EM: "Available jobs retrieved successfully.", 
          EC: 0, 
          DT: jobs 
        };
    } catch (error) {
        console.log(">>> Error in getAvailableJobsForHandymanService: ", error);
        return { 
          EM: "Internal server error while retrieving available jobs.", 
          EC: 500, 
          DT: "" 
        };
    }
};

export { getAvailableJobsForHandymanService };