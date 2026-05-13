import express from 'express';
import { handleSubmitKyc } from '../controllers/Kyc.controller.js';
import { checkUserJWT } from '../../../core/middlewares/auth.middleware.js';
import { uploadKycMiddleware } from '../../../core/config/cloudinary.config.js'; 

const router = express.Router();

//  Auth -> Upload -> Controller
router.post('/kyc/upload', checkUserJWT, uploadKycMiddleware, handleSubmitKyc);

export default router;