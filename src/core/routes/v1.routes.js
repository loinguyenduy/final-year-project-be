import express from 'express';
import authRoutes from '../../modules/identity/routes/Auth.routes.js';
import socialAuthRoutes from '../../modules/identity/routes/SocialAuth.routes.js';
import fintechRoutes from '../../modules/fintech/routes/fintech.routes.js'; 
import kycRoutes from '../../modules/identity/routes/Kyc.routes.js';
import adminRoutes from '../../modules/admin/routes/Admin.routes.js';
import profileRoutes from '../../modules/identity/routes/Profile.routes.js';
import matchmakingRoutes from '../../modules/matchmaking/routes/Job.routes.js';

const router = express.Router();

// Auth routes
router.use('/auth', authRoutes);
router.use('/auth', socialAuthRoutes); 

// Profile routes
router.use('/identity', profileRoutes);

// Fintech routes
router.use('/fintech', fintechRoutes);

// KYC routes
router.use('/identity', kycRoutes);

// Admin routes
router.use('/admin', adminRoutes);

// Matchmaking routes
router.use('/matchmaking', matchmakingRoutes);

export default router;