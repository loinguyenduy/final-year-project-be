import express from 'express';
import {
  decideKycRequest,
  getKycDocumentAccess,
  getKycRequestDetail,
  listKycRequests
} from '../controllers/AdminKyc.controller.js';
import { listAdminAuditLogs } from '../controllers/AdminAudit.controller.js';
import { getQueueCounts } from '../controllers/AdminQueue.controller.js';
import {
  decideWarrantyClaimController,
  decideWarrantyReworkController,
  decideCancellationController,
  getReviewCaseDetailController,
  getReviewChatController,
  getReviewEvidenceAccessController,
  listReviewCases
} from '../controllers/AdminReview.controller.js';
import { checkUserJWT } from '../../../core/middlewares/auth.middleware.js';
import { requireActiveAdmin } from '../middlewares/adminAuth.middleware.js';
import { adminMutationRateLimiter } from '../../../core/middlewares/rateLimit.middleware.js';
import {
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
} from '../controllers/AdminJob.controller.js';

const router = express.Router();


router.use(checkUserJWT, requireActiveAdmin);

router.get('/queue-counts', getQueueCounts);
router.get('/jobs', listAdminJobs);
router.get('/jobs/:jobId', getAdminJob);
router.get('/jobs/:jobId/bids', listAdminJobBids);
router.get('/jobs/:jobId/cycles', listAdminJobCycles);
router.get('/jobs/:jobId/cycles/:acceptanceCycle', getAdminJobCycle);
router.get('/jobs/:jobId/evidence', listAdminJobEvidence);
router.get('/jobs/:jobId/evidence/:evidenceId/access', getAdminJobEvidenceAccessController);
router.get('/jobs/:jobId/images/:imageKey/access', getAdminJobImageAccessController);
router.get('/jobs/:jobId/timeline', listAdminJobTimeline);
router.get('/jobs/:jobId/audits', listAdminJobAudits);
router.get('/jobs/:jobId/chat', getAdminJobChatController);
router.get('/jobs/:jobId/transactions', listAdminJobTransactions);
router.get('/reviews', listReviewCases);
router.get('/reviews/:caseType/:caseId', getReviewCaseDetailController);
router.get('/reviews/:caseType/:caseId/chat', getReviewChatController);
router.get('/reviews/:caseType/:caseId/evidence/:evidenceId/access', getReviewEvidenceAccessController);
router.post('/reviews/warranty-claims/:claimId/decision', adminMutationRateLimiter, decideWarrantyClaimController);
router.post('/reviews/warranty-reworks/:requestId/decision', adminMutationRateLimiter, decideWarrantyReworkController);
router.post('/reviews/cancellations/:cancellationId/decision', adminMutationRateLimiter, decideCancellationController);
router.get('/kyc/requests', listKycRequests);
router.get('/kyc/requests/:submissionId', getKycRequestDetail);
router.get('/kyc/requests/:submissionId/documents/:documentId/access', getKycDocumentAccess);
router.post('/kyc/requests/:submissionId/decision', adminMutationRateLimiter, decideKycRequest);
router.get('/audit-logs', listAdminAuditLogs);

export default router;
