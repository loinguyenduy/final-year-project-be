import express from 'express';
import {
  decideKycRequest,
  getKycDocumentAccess,
  getKycRequestDetail,
  listKycRequests
} from '../controllers/AdminKyc.controller.js';
import { listAdminAuditLogs } from '../controllers/AdminAudit.controller.js';
import { getQueueCounts } from '../controllers/AdminQueue.controller.js';
import { checkUserJWT } from '../../../core/middlewares/auth.middleware.js';
import { requireActiveAdmin } from '../middlewares/adminAuth.middleware.js';
import { adminMutationRateLimiter } from '../../../core/middlewares/rateLimit.middleware.js';

const router = express.Router();


router.use(checkUserJWT, requireActiveAdmin);

router.get('/queue-counts', getQueueCounts);
router.get('/kyc/requests', listKycRequests);
router.get('/kyc/requests/:submissionId', getKycRequestDetail);
router.get('/kyc/requests/:submissionId/documents/:documentId/access', getKycDocumentAccess);
router.post('/kyc/requests/:submissionId/decision', adminMutationRateLimiter, decideKycRequest);
router.get('/audit-logs', listAdminAuditLogs);

export default router;
