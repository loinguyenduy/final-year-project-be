import { getAdminQueueCounts } from '../services/AdminQueue.service.js';

const getQueueCounts = async (req, res) => {
  try {
    return res.status(200).json({
      EM: 'Administrator queue counts retrieved successfully.',
      EC: 0,
      code: 'ADMIN_QUEUE_COUNTS_RETRIEVED',
      DT: await getAdminQueueCounts()
    });
  } catch (error) {
    console.error('[admin-queue] Unable to retrieve queue counts.', {
      correlation_id: req.correlationId,
      error: error.message
    });
    return res.status(500).json({
      EM: 'Unable to retrieve administrator queue counts.',
      EC: 500,
      code: 'INTERNAL_SERVER_ERROR',
      DT: ''
    });
  }
};

export { getQueueCounts };
