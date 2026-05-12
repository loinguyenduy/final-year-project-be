import express from 'express';
import { handleSubmitKyc } from '../controllers/Kyc.controller.js';
import { checkUserJWT } from '../../../core/middlewares/auth.middleware.js';
import { uploadKycMiddleware } from '../../../core/config/cloudinary.config.js'; // Đường dẫn tới file config bước trước

const router = express.Router();

// Bắt buộc tuân thủ thứ tự Middleware: Auth -> Upload -> Controller
router.post('/kyc/upload', checkUserJWT, uploadKycMiddleware, handleSubmitKyc);

export default router;