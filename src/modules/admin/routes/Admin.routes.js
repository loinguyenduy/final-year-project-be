import express from 'express';
import { getPendingKyc, reviewKyc } from '../controllers/AdminKyc.controller.js';
import { checkUserJWT, checkUserRole } from '../../../core/middlewares/auth.middleware.js';

const router = express.Router();


router.get('/kyc/pending', checkUserJWT, checkUserRole(['ADMIN']), getPendingKyc);
router.post('/kyc/review', checkUserJWT, checkUserRole(['ADMIN']), reviewKyc);

export default router;