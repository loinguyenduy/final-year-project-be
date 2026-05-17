import express from 'express';
import authRoutes from '../../modules/identity/routes/Auth.routes.js';
import socialAuthRoutes from '../../modules/identity/routes/SocialAuth.routes.js';
import fintechRoutes from '../../modules/fintech/routes/fintech.routes.js'; 
import kycRoutes from '../../modules/identity/routes/Kyc.routes.js';
import adminRoutes from '../../modules/admin/routes/Admin.routes.js';
const router = express.Router();

// Auth routes
router.use('/auth', authRoutes);
router.use('/auth', socialAuthRoutes); 

// Fintech routes
router.use('/fintech', fintechRoutes);

// KYC routes
router.use('/identity', kycRoutes);

// Admin routes
router.use('/admin', adminRoutes);

export default router;