import express from "express";
import {
  getAdminSession,
  loginAdmin,
  loginUser,
  logoutUser,
  registerNewUser,
  requestRefreshToken,
  resendVerifyEmail,
  verifyEmail
} from '../controllers/Auth.controller.js';
import { checkUserJWT } from '../../../core/middlewares/auth.middleware.js';
import { requireActiveAdmin } from '../../admin/middlewares/adminAuth.middleware.js';
import {
  adminLoginRateLimiter,
  participantLoginRateLimiter
} from '../../../core/middlewares/rateLimit.middleware.js';

const router = express.Router();

router.post("/register", registerNewUser);
router.post('/login', participantLoginRateLimiter, loginUser);
router.post('/admin/login', adminLoginRateLimiter, loginAdmin);
router.get('/admin/session', checkUserJWT, requireActiveAdmin, getAdminSession);
router.post("/refresh", requestRefreshToken);
router.post("/logout", logoutUser);
router.get("/verify-email", verifyEmail);
router.post("/resend-verification", resendVerifyEmail);

export default router;
