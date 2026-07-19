import express from 'express';
import {
    handleCancelPreAcceptanceJob,
    handleCreateJob,
    handleGetCustomerJobs,
    handlePreflightEditJob,
    handleUpdatePostedJob
} from '../controllers/CustomerJob.controller.js';
import { handleGetAvailableJobs } from '../controllers/HandymanJob.controller.js';
import { handleGetJobDetails, handleGetServices } from '../controllers/Job.controller.js';
import {
    handleGetProvinces,
    handleGetWards,
    handleGeocodeAddress,
    handleReverseGeocode
} from '../controllers/Location.controller.js';
import { handleSubmitBid, handleUpdateBid, handleWithdrawBid, handleGetMyBids } from '../controllers/Bid.controller.js';
import {
    handleAcceptWithWalletDeposit,
    handleCompareBids,
    handleGetDepositSummary,
    handleGetPublicHandymanProfile
} from '../controllers/CustomerHandymanSelection.controller.js';
import { checkUserJWT, checkUserRole } from '../../../core/middlewares/auth.middleware.js';
import { uploadJobImagesMiddleware } from '../../../core/config/cloudinary.config.js';
import { handleGetAcceptedDetails, handleStartMoving } from '../controllers/AcceptedJob.controller.js';
import {
    handleCancelByCustomer,
    handleCancelByHandyman
} from '../controllers/AcceptedCancellation.controller.js';
import {
    handleConfirmCancellation,
    handleCreateCancellation,
    handleGetCurrentCancellation,
    handleRejectCancellation
} from '../controllers/LifecycleCancellation.controller.js';
import {
    handleConfirmArrival,
    handleRejectArrival,
    handleRequestArrival
} from '../controllers/Arrival.controller.js';
import {
    handleAcceptQuote,
    handleCreateOrGetQuoteDraft,
    handleGetCurrentQuote,
    handleRejectQuote,
    handleSubmitQuote,
    handleUpdateQuoteDraft
} from '../controllers/Quote.controller.js';
import {
    handleDeleteBeforeEvidence,
    handleListBeforeEvidence,
    handleUploadBeforeEvidence
} from '../controllers/InspectionEvidence.controller.js';
import {
    handleGetContract,
    handleGetPaymentSummary,
    handlePayRemainingAmount
} from '../controllers/QuotePayment.controller.js';
import {
    handleConfirmCompletionRequest,
    handleCreateCompletionRequest,
    handleGetCompletionRequestEvidence,
    handleListCompletionRequests,
    handleRejectCompletionRequest
} from '../controllers/CompletionRequest.controller.js';
import {
    handleDeleteAfterEvidence,
    handleDeleteClaimEvidence,
    handleDeleteDuringEvidence,
    handleDeleteWarrantyEvidence,
    handleListAfterEvidence,
    handleListClaimDraftEvidence,
    handleListDuringEvidence,
    handleListWarrantyEvidence,
    handleUploadAfterEvidence,
    handleUploadClaimEvidence,
    handleUploadDuringEvidence,
    handleUploadWarrantyEvidence
} from '../controllers/WorkEvidence.controller.js';
import {
    handleConfirmWarrantyCompletionRequest,
    handleCreateWarrantyClaim,
    handleCreateWarrantyCompletionRequest,
    handleGetWarranty,
    handleGetWarrantyClaimEvidence,
    handleGetWarrantyCompletionEvidence,
    handleListWarrantyClaims,
    handleListWarrantyCompletionRequests,
    handleRejectWarrantyCompletionRequest
} from '../controllers/Warranty.controller.js';

const router = express.Router();

// Public
router.get('/services', handleGetServices);
router.get('/provinces', handleGetProvinces);
router.get('/wards', handleGetWards);

// CUSTOMER JOB
router.post('/locations/geocode', checkUserJWT, checkUserRole(['CUSTOMER']), handleGeocodeAddress);
router.post('/locations/reverse-geocode', checkUserJWT, checkUserRole(['CUSTOMER']), handleReverseGeocode);
router.post('/jobs', checkUserJWT, checkUserRole(['CUSTOMER']), uploadJobImagesMiddleware, handleCreateJob);
router.get('/jobs', checkUserJWT, checkUserRole(['CUSTOMER']), handleGetCustomerJobs);
router.patch(
    '/jobs/:jobId',
    checkUserJWT,
    checkUserRole(['CUSTOMER']),
    handlePreflightEditJob,
    uploadJobImagesMiddleware,
    handleUpdatePostedJob
);
router.post(
    '/jobs/:jobId/pre-acceptance-cancellation',
    checkUserJWT,
    checkUserRole(['CUSTOMER']),
    handleCancelPreAcceptanceJob
);

// HANDYMAN JOB
router.get('/jobs/available', checkUserJWT, checkUserRole(['HANDYMAN']), handleGetAvailableJobs);

// BIDDING — Handyman actions
router.get('/handyman/my-bids', checkUserJWT, checkUserRole(['HANDYMAN']), handleGetMyBids);
router.post('/jobs/:id/bids', checkUserJWT, checkUserRole(['HANDYMAN']), handleSubmitBid);
router.patch('/jobs/:id/bids/:bidId', checkUserJWT, checkUserRole(['HANDYMAN']), handleUpdateBid);
router.delete('/jobs/:id/bids/:bidId', checkUserJWT, checkUserRole(['HANDYMAN']), handleWithdrawBid);

// BIDDING — Customer actions
router.get('/jobs/:id/bids/:bidId/deposit-summary', checkUserJWT, checkUserRole(['CUSTOMER']), handleGetDepositSummary);
router.post('/jobs/:id/bids/:bidId/accept-with-wallet-deposit', checkUserJWT, checkUserRole(['CUSTOMER']), handleAcceptWithWalletDeposit);
router.get('/jobs/:id/handymen/:handymanId/public-profile', checkUserJWT, checkUserRole(['CUSTOMER']), handleGetPublicHandymanProfile);
router.post('/bids/compare', checkUserJWT, checkUserRole(['CUSTOMER']), handleCompareBids);

// ACCEPTED JOB
router.get(
    '/jobs/:id/accepted-details',
    checkUserJWT,
    checkUserRole(['CUSTOMER', 'HANDYMAN', 'ADMIN']),
    handleGetAcceptedDetails
);
router.post(
    '/jobs/:id/cancel-by-customer',
    checkUserJWT,
    checkUserRole(['CUSTOMER']),
    handleCancelByCustomer
);
router.post(
    '/jobs/:id/cancel-by-handyman',
    checkUserJWT,
    checkUserRole(['HANDYMAN']),
    handleCancelByHandyman
);
router.post(
    '/jobs/:jobId/cancellations',
    checkUserJWT,
    checkUserRole(['CUSTOMER', 'HANDYMAN']),
    handleCreateCancellation
);
router.get(
    '/jobs/:jobId/cancellations/current',
    checkUserJWT,
    checkUserRole(['CUSTOMER', 'HANDYMAN', 'ADMIN']),
    handleGetCurrentCancellation
);
router.post(
    '/jobs/:jobId/cancellations/:cancellationId/confirm',
    checkUserJWT,
    checkUserRole(['CUSTOMER', 'HANDYMAN']),
    handleConfirmCancellation
);
router.post(
    '/jobs/:jobId/cancellations/:cancellationId/reject',
    checkUserJWT,
    checkUserRole(['CUSTOMER', 'HANDYMAN']),
    handleRejectCancellation
);
router.post(
    '/jobs/:id/start-moving',
    checkUserJWT,
    checkUserRole(['HANDYMAN']),
    handleStartMoving
);
router.post(
    '/jobs/:id/arrival-requests',
    checkUserJWT,
    checkUserRole(['HANDYMAN']),
    handleRequestArrival
);
router.post(
    '/jobs/:id/arrival-requests/:requestId/confirm',
    checkUserJWT,
    checkUserRole(['CUSTOMER']),
    handleConfirmArrival
);
router.post(
    '/jobs/:id/arrival-requests/:requestId/reject',
    checkUserJWT,
    checkUserRole(['CUSTOMER']),
    handleRejectArrival
);

// ARRIVED INSPECTION EVIDENCE
router.post(
    '/jobs/:jobId/evidence/before',
    checkUserJWT,
    checkUserRole(['HANDYMAN']),
    handleUploadBeforeEvidence
);
router.get(
    '/jobs/:jobId/evidence/before',
    checkUserJWT,
    checkUserRole(['CUSTOMER', 'HANDYMAN', 'ADMIN']),
    handleListBeforeEvidence
);
router.delete(
    '/jobs/:jobId/evidence/before/:evidenceId',
    checkUserJWT,
    checkUserRole(['HANDYMAN']),
    handleDeleteBeforeEvidence
);

// ARRIVED INSPECTION QUOTE
router.post(
    '/jobs/:jobId/quotes/draft',
    checkUserJWT,
    checkUserRole(['HANDYMAN']),
    handleCreateOrGetQuoteDraft
);
router.put(
    '/jobs/:jobId/quotes/:quoteId',
    checkUserJWT,
    checkUserRole(['HANDYMAN']),
    handleUpdateQuoteDraft
);
router.post(
    '/jobs/:jobId/quotes/:quoteId/submit',
    checkUserJWT,
    checkUserRole(['HANDYMAN']),
    handleSubmitQuote
);
router.get(
    '/jobs/:jobId/quotes/current',
    checkUserJWT,
    checkUserRole(['CUSTOMER', 'HANDYMAN', 'ADMIN']),
    handleGetCurrentQuote
);
router.post(
    '/jobs/:jobId/quotes/:quoteId/accept',
    checkUserJWT,
    checkUserRole(['CUSTOMER']),
    handleAcceptQuote
);
router.post(
    '/jobs/:jobId/quotes/:quoteId/reject',
    checkUserJWT,
    checkUserRole(['CUSTOMER']),
    handleRejectQuote
);

// QUOTE PAYMENT AND IMMUTABLE CONTRACT
router.post(
    '/jobs/:jobId/payments/remaining',
    checkUserJWT,
    checkUserRole(['CUSTOMER']),
    handlePayRemainingAmount
);
router.get(
    '/jobs/:jobId/payment-summary',
    checkUserJWT,
    checkUserRole(['CUSTOMER', 'HANDYMAN', 'ADMIN']),
    handleGetPaymentSummary
);
router.get(
    '/jobs/:jobId/contract',
    checkUserJWT,
    checkUserRole(['CUSTOMER', 'HANDYMAN', 'ADMIN']),
    handleGetContract
);

// COMMON JOB — must come after /jobs/available to avoid param collision
// IN-PROGRESS WORK EVIDENCE
router.post('/jobs/:jobId/evidence/during', checkUserJWT, checkUserRole(['HANDYMAN']), handleUploadDuringEvidence);
router.get('/jobs/:jobId/evidence/during', checkUserJWT, checkUserRole(['HANDYMAN', 'ADMIN']), handleListDuringEvidence);
router.delete('/jobs/:jobId/evidence/during/:evidenceId', checkUserJWT, checkUserRole(['HANDYMAN']), handleDeleteDuringEvidence);
router.post('/jobs/:jobId/evidence/after', checkUserJWT, checkUserRole(['HANDYMAN']), handleUploadAfterEvidence);
router.get('/jobs/:jobId/evidence/after', checkUserJWT, checkUserRole(['HANDYMAN', 'ADMIN']), handleListAfterEvidence);
router.delete('/jobs/:jobId/evidence/after/:evidenceId', checkUserJWT, checkUserRole(['HANDYMAN']), handleDeleteAfterEvidence);

// STANDARD COMPLETION
router.post('/jobs/:jobId/completion-requests', checkUserJWT, checkUserRole(['HANDYMAN']), handleCreateCompletionRequest);
router.get('/jobs/:jobId/completion-requests', checkUserJWT, checkUserRole(['CUSTOMER', 'HANDYMAN', 'ADMIN']), handleListCompletionRequests);
router.get('/jobs/:jobId/completion-requests/:requestId/evidence', checkUserJWT, checkUserRole(['HANDYMAN', 'ADMIN']), handleGetCompletionRequestEvidence);
router.post('/jobs/:jobId/completion-requests/:requestId/confirm', checkUserJWT, checkUserRole(['CUSTOMER']), handleConfirmCompletionRequest);
router.post('/jobs/:jobId/completion-requests/:requestId/reject', checkUserJWT, checkUserRole(['CUSTOMER']), handleRejectCompletionRequest);

// WARRANTY AND CLAIM
router.get('/jobs/:jobId/warranty', checkUserJWT, checkUserRole(['CUSTOMER', 'HANDYMAN', 'ADMIN']), handleGetWarranty);
router.post('/jobs/:jobId/evidence/warranty-claim', checkUserJWT, checkUserRole(['CUSTOMER']), handleUploadClaimEvidence);
router.get('/jobs/:jobId/evidence/warranty-claim', checkUserJWT, checkUserRole(['CUSTOMER', 'ADMIN']), handleListClaimDraftEvidence);
router.delete('/jobs/:jobId/evidence/warranty-claim/:evidenceId', checkUserJWT, checkUserRole(['CUSTOMER']), handleDeleteClaimEvidence);
router.post('/jobs/:jobId/warranty/claims', checkUserJWT, checkUserRole(['CUSTOMER']), handleCreateWarrantyClaim);
router.get('/jobs/:jobId/warranty/claims', checkUserJWT, checkUserRole(['CUSTOMER', 'HANDYMAN', 'ADMIN']), handleListWarrantyClaims);
router.get('/jobs/:jobId/warranty/claims/:claimId/evidence', checkUserJWT, checkUserRole(['CUSTOMER', 'HANDYMAN', 'ADMIN']), handleGetWarrantyClaimEvidence);

// WARRANTY REWORK
router.post('/jobs/:jobId/evidence/warranty', checkUserJWT, checkUserRole(['HANDYMAN']), handleUploadWarrantyEvidence);
router.get('/jobs/:jobId/evidence/warranty', checkUserJWT, checkUserRole(['HANDYMAN', 'ADMIN']), handleListWarrantyEvidence);
router.delete('/jobs/:jobId/evidence/warranty/:evidenceId', checkUserJWT, checkUserRole(['HANDYMAN']), handleDeleteWarrantyEvidence);
router.post('/jobs/:jobId/warranty/completion-requests', checkUserJWT, checkUserRole(['HANDYMAN']), handleCreateWarrantyCompletionRequest);
router.get('/jobs/:jobId/warranty/completion-requests', checkUserJWT, checkUserRole(['CUSTOMER', 'HANDYMAN', 'ADMIN']), handleListWarrantyCompletionRequests);
router.get('/jobs/:jobId/warranty/completion-requests/:requestId/evidence', checkUserJWT, checkUserRole(['HANDYMAN', 'ADMIN']), handleGetWarrantyCompletionEvidence);
router.post('/jobs/:jobId/warranty/completion-requests/:requestId/confirm', checkUserJWT, checkUserRole(['CUSTOMER']), handleConfirmWarrantyCompletionRequest);
router.post('/jobs/:jobId/warranty/completion-requests/:requestId/reject', checkUserJWT, checkUserRole(['CUSTOMER']), handleRejectWarrantyCompletionRequest);

router.get('/jobs/:id', checkUserJWT, handleGetJobDetails);

export default router;
