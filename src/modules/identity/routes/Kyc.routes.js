import express from 'express';
import { handleSubmitKyc, handleHandymanKyc } from '../controllers/Kyc.controller.js';
import { checkUserJWT, checkUserRole  } from '../../../core/middlewares/auth.middleware.js';
import { uploadKycMiddleware } from '../../../core/config/cloudinary.config.js'; 

const router = express.Router();

//  Auth -> Upload -> Controller
router.post('/kyc/customer/upload', checkUserJWT, uploadKycMiddleware, handleSubmitKyc);

// Handyman KYC route 
router.post('/kyc/handyman/upload', checkUserJWT, checkUserRole(['HANDYMAN']), uploadKycMiddleware, handleHandymanKyc);

export default router;