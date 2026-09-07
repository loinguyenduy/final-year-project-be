import express from 'express';
import { checkUserJWT, checkUserRole } from '../../../core/middlewares/auth.middleware.js';
import {
  aiCustomerRateLimiter,
  aiIpRateLimiter
} from '../../../core/middlewares/rateLimit.middleware.js';
import {
  handleAbandonSession,
  handleCreateSession,
  handleDiagnosisDecision,
  handleGetSession,
  handlePriceDecision,
  handleSendMessage
} from '../controllers/AiAssistant.controller.js';

const router = express.Router();

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});
router.use(checkUserJWT);
router.use(checkUserRole(['CUSTOMER']));
router.use(aiIpRateLimiter);
router.use(aiCustomerRateLimiter);

router.post('/sessions', handleCreateSession);
router.get('/sessions/:sessionId', handleGetSession);
router.post('/sessions/:sessionId/messages', handleSendMessage);
router.post('/sessions/:sessionId/diagnosis-decision', handleDiagnosisDecision);
router.post('/sessions/:sessionId/price-decision', handlePriceDecision);
router.post('/sessions/:sessionId/abandon', handleAbandonSession);

export default router;
