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
import { passwordActionRateLimiter } from '../../../core/middlewares/rateLimit.middleware.js';
import { checkUserRole } from '../../../core/middlewares/auth.middleware.js';
import {
  changeCurrentPassword,
  completeReset,
  completeSet,
  forgotPassword,
  requestSetPasswordEmail,
  validateResetToken,
  validateSetToken
} from '../controllers/Password.controller.js';

const router = express.Router();

router.post("/register", registerNewUser);
router.post('/login', participantLoginRateLimiter, loginUser);
router.post('/admin/login', adminLoginRateLimiter, loginAdmin);
router.get('/admin/session', checkUserJWT, requireActiveAdmin, getAdminSession);
router.post("/refresh", requestRefreshToken);
router.post("/logout", logoutUser);
router.get("/verify-email", verifyEmail);
router.post("/resend-verification", resendVerifyEmail);
router.post('/forgot-password', passwordActionRateLimiter, forgotPassword);
router.post('/password-reset/validate', passwordActionRateLimiter, validateResetToken);
router.post('/password-reset/complete', passwordActionRateLimiter, completeReset);
router.post('/change-password', passwordActionRateLimiter, checkUserJWT, checkUserRole(['CUSTOMER', 'HANDYMAN']), changeCurrentPassword);
router.post('/set-password/request', passwordActionRateLimiter, checkUserJWT, checkUserRole(['CUSTOMER', 'HANDYMAN']), requestSetPasswordEmail);
router.post('/set-password/validate', passwordActionRateLimiter, validateSetToken);
router.post('/set-password/complete', passwordActionRateLimiter, completeSet);

export default router;
