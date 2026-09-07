import express from 'express';
import { handleSubmitKyc, handleHandymanKyc } from '../controllers/Kyc.controller.js';
import { checkUserJWT } from '../../../core/middlewares/auth.middleware.js';
import { uploadKycMiddleware } from '../../../core/config/cloudinary.config.js'; 
import { requireKycSubmissionEligibility } from '../middlewares/kycEligibility.middleware.js';

const router = express.Router();

//  Auth -> Upload -> Controller
router.post(
  '/kyc/customer/upload',
  checkUserJWT,
  requireKycSubmissionEligibility('CUSTOMER'),
  uploadKycMiddleware,
  handleSubmitKyc
);

// Handyman KYC route 
router.post(
  '/kyc/handyman/upload',
  checkUserJWT,
  requireKycSubmissionEligibility('HANDYMAN'),
  uploadKycMiddleware,
  handleHandymanKyc
);

export default router;
