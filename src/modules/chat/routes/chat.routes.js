import express from 'express';
import { checkUserJWT, checkUserRole } from '../../../core/middlewares/auth.middleware.js';
import {
  handleCreateOrGetConversation,
  handleGetConversation,
  handleGetMessages
} from '../controllers/Chat.controller.js';

const router = express.Router();
const participantAuth = [checkUserJWT, checkUserRole(['CUSTOMER', 'HANDYMAN'])];

router.post('/jobs/:jobId/conversation', ...participantAuth, handleCreateOrGetConversation);
router.get('/jobs/:jobId/conversation', ...participantAuth, handleGetConversation);
router.get('/conversations/:conversationId/messages', ...participantAuth, handleGetMessages);

export default router;
