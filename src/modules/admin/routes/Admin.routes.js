import express from 'express';
import { getPendingKyc, reviewKyc } from '../controllers/AdminKyc.controller.js';
import { checkUserJWT, checkUserRole } from '../../../core/middlewares/auth.middleware.js';

const router = express.Router();

router.use(checkUserJWT);
router.use(checkUserRole(['ADMIN']));

router.get('/kyc/pending', getPendingKyc);
router.post('/kyc/review', reviewKyc);

export default router;