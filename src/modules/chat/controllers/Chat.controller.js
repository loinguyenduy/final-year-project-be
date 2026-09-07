import {
  createOrGetConversationService,
  getConversationByJobService
} from '../services/Conversation.service.js';
import { getMessageHistoryService } from '../services/Message.service.js';
import { ChatError, toErrorEnvelope } from '../utils/chatError.util.js';

const getHttpStatus = (errorCode) => {
  if ([400, 401, 403, 404, 409, 429].includes(errorCode)) return errorCode;
  return 500;
};

const sendControllerError = (res, error, operation) => {
  if (!(error instanceof ChatError)) {
    console.error(`[chat] ${operation} failed.`, error);
  }
  const envelope = toErrorEnvelope(error);
  return res.status(getHttpStatus(envelope.EC)).json(envelope);
};

const handleCreateOrGetConversation = async (req, res) => {
  try {
    const result = await createOrGetConversationService(req.params.jobId, req.user.id);
    return res.status(result.created ? 201 : 200).json({
      EM: result.created ? 'Conversation created successfully.' : 'Conversation retrieved successfully.',
      EC: 0,
      code: result.created ? 'CONVERSATION_CREATED' : 'CONVERSATION_EXISTS',
      DT: result
    });
  } catch (error) {
    return sendControllerError(res, error, 'Create/get conversation');
  }
};

const handleGetConversation = async (req, res) => {
  try {
    const conversation = await getConversationByJobService(req.params.jobId, req.user.id);
    return res.status(200).json({
      EM: 'Conversation retrieved successfully.',
      EC: 0,
      code: 'CONVERSATION_RETRIEVED',
      DT: { conversation }
    });
  } catch (error) {
    return sendControllerError(res, error, 'Get conversation');
  }
};

const handleGetMessages = async (req, res) => {
  try {
    const result = await getMessageHistoryService({
      conversationId: req.params.conversationId,
      userId: req.user.id,
      cursor: req.query.cursor,
      limit: req.query.limit
    });
    return res.status(200).json({
      EM: 'Message history retrieved successfully.',
      EC: 0,
      code: 'MESSAGE_HISTORY_RETRIEVED',
      DT: result
    });
  } catch (error) {
    return sendControllerError(res, error, 'Get message history');
  }
};

export {
  handleCreateOrGetConversation,
  handleGetConversation,
  handleGetMessages
};
