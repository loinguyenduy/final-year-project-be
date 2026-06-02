import express from 'express';
import { handleGetUserProfile } from '../controllers/Profile.controller.js';
import { checkUserJWT } from '../../../core/middlewares/auth.middleware.js';

const router = express.Router();

router.get('/profile', checkUserJWT, handleGetUserProfile);

export default router;