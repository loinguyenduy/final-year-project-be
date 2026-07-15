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
    checkUserRole(['CUSTOMER', 'HANDYMAN']),
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
    '/jobs/:id/start-moving',
    checkUserJWT,
    checkUserRole(['HANDYMAN']),
    handleStartMoving
);

// COMMON JOB — must come after /jobs/available to avoid param collision
router.get('/jobs/:id', checkUserJWT, handleGetJobDetails);

export default router;
