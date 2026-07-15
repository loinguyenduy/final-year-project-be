import express from 'express';
import { handleCreateJob, handleGetCustomerJobs } from '../controllers/CustomerJob.controller.js';
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
    handleCreateOrGetQuoteDraft,
    handleGetCurrentQuote,
    handleSubmitQuote,
    handleUpdateQuoteDraft
} from '../controllers/Quote.controller.js';
import {
    handleDeleteBeforeEvidence,
    handleListBeforeEvidence,
    handleUploadBeforeEvidence
} from '../controllers/InspectionEvidence.controller.js';

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

// COMMON JOB — must come after /jobs/available to avoid param collision
router.get('/jobs/:id', checkUserJWT, handleGetJobDetails);

export default router;
