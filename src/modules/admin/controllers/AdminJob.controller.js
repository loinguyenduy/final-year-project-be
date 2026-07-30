import {
  getAdminJobAudits,
  getAdminJobBids,
  getAdminJobChat,
  getAdminJobCycleDetail,
  getAdminJobCycles,
  getAdminJobDetail,
  getAdminJobEvidence,
  getAdminJobEvidenceAccess,
  getAdminJobImageAccess,
  getAdminJobTimeline,
  getAdminJobTransactions,
  getAdminJobs
} from '../services/AdminJob.service.js';
import { handleAdminReviewError } from './AdminReview.controller.js';

const respond = (res, { message, code, data }) => {
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({ EM: message, EC: 0, code, DT: data });
};

const withJobHandler = (handler, response) => async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    const data = await handler({
      ...req.params,
      query: req.query,
      admin: req.admin,
      correlationId: req.correlationId
    });
    return respond(res, { ...response, data });
  } catch (error) {
    return handleAdminReviewError(req, res, error);
  }
};

const listAdminJobs = withJobHandler(
  ({ query }) => getAdminJobs(query),
  { message: 'Admin Jobs retrieved successfully.', code: 'ADMIN_JOBS_RETRIEVED' }
);

const getAdminJob = withJobHandler(
  getAdminJobDetail,
  { message: 'Admin Job detail retrieved successfully.', code: 'ADMIN_JOB_RETRIEVED' }
);

const listAdminJobBids = withJobHandler(
  getAdminJobBids,
  { message: 'Job bids retrieved successfully.', code: 'ADMIN_JOB_BIDS_RETRIEVED' }
);

const listAdminJobCycles = withJobHandler(
  getAdminJobCycles,
  { message: 'Job acceptance cycles retrieved successfully.', code: 'ADMIN_JOB_CYCLES_RETRIEVED' }
);

const getAdminJobCycle = withJobHandler(
  getAdminJobCycleDetail,
  { message: 'Job acceptance cycle retrieved successfully.', code: 'ADMIN_JOB_CYCLE_RETRIEVED' }
);

const listAdminJobEvidence = withJobHandler(
  getAdminJobEvidence,
  { message: 'Job Evidence metadata retrieved successfully.', code: 'ADMIN_JOB_EVIDENCE_RETRIEVED' }
);

const listAdminJobTimeline = withJobHandler(
  getAdminJobTimeline,
  { message: 'Job timeline retrieved successfully.', code: 'ADMIN_JOB_TIMELINE_RETRIEVED' }
);

const listAdminJobAudits = withJobHandler(
  getAdminJobAudits,
  { message: 'Job Admin decisions retrieved successfully.', code: 'ADMIN_JOB_AUDITS_RETRIEVED' }
);

const getAdminJobChatController = withJobHandler(
  getAdminJobChat,
  { message: 'Job Chat transcript retrieved successfully.', code: 'ADMIN_JOB_CHAT_RETRIEVED' }
);

const listAdminJobTransactions = withJobHandler(
  getAdminJobTransactions,
  { message: 'Job Transactions retrieved successfully.', code: 'ADMIN_JOB_TRANSACTIONS_RETRIEVED' }
);

const getAdminJobEvidenceAccessController = withJobHandler(
  getAdminJobEvidenceAccess,
  { message: 'Job Evidence access granted.', code: 'ADMIN_JOB_EVIDENCE_ACCESS_GRANTED' }
);

const getAdminJobImageAccessController = withJobHandler(
  getAdminJobImageAccess,
  { message: 'Job image access granted.', code: 'ADMIN_JOB_IMAGE_ACCESS_GRANTED' }
);

export {
  getAdminJob,
  getAdminJobChatController,
  getAdminJobCycle,
  getAdminJobEvidenceAccessController,
  getAdminJobImageAccessController,
  listAdminJobAudits,
  listAdminJobBids,
  listAdminJobCycles,
  listAdminJobEvidence,
  listAdminJobTimeline,
  listAdminJobTransactions,
  listAdminJobs
};
