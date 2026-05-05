import express from 'express';
import authRoutes from '../../modules/identity/routes/Auth.routes.js';
import socialAuthRoutes from '../../modules/identity/routes/SocialAuth.routes.js'; 

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/auth', socialAuthRoutes); 

export default router;