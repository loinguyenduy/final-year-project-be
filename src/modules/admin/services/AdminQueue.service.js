import { Op } from 'sequelize';
import KycRequest from '../../identity/models/KycRequest.model.js';

const getAdminQueueCounts = async () => {
  const kycPending = await KycRequest.count({
    distinct: true,
    col: 'submission_id',
    where: {
      submission_id: { [Op.ne]: null },
      status: 'PENDING'
    }
  });
  return { kyc_pending: Number(kycPending) || 0 };
};

export { getAdminQueueCounts };
