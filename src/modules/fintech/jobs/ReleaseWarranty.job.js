import { Op } from 'sequelize';
import JobWarranty from '../../matchmaking/models/JobWarranty.model.js';
import { releaseExpiredWarrantyService } from '../services/WarrantySettlement.service.js';

const getBatchSize = () => {
    const configured = Number(
        process.env.JOB_WARRANTY_RELEASE_BATCH_SIZE
        || process.env.WARRANTY_RELEASE_BATCH_SIZE
        || 50
    );
    return Number.isInteger(configured) && configured > 0 && configured <= 500
        ? configured
        : 50;
};

const releaseExpiredWarranties = async (now = new Date()) => {
    const candidates = await JobWarranty.findAll({
        where: {
            status: 'ACTIVE',
            released_at: null,
            ends_at: { [Op.lte]: now }
        },
        attributes: ['id'],
        order: [['ends_at', 'ASC'], ['id', 'ASC']],
        limit: getBatchSize()
    });
    const summary = { candidates: candidates.length, released: 0, skipped: 0, failed: 0 };
    for (const candidate of candidates) {
        const result = await releaseExpiredWarrantyService(candidate.id, now);
        if (result.EC !== 0) {
            summary.failed += 1;
            console.error('[CronJob] Warranty release candidate failed.', {
                warranty_id: candidate.id,
                code: result.code,
                message: result.EM
            });
        } else if (result.code === 'WARRANTY_RELEASED') {
            summary.released += 1;
        } else {
            summary.skipped += 1;
        }
    }
    return summary;
};

export { releaseExpiredWarranties };
