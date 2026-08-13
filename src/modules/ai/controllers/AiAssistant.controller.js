import AiError from '../utils/AiError.js';
import {
  abandonSession,
  createSession,
  getSession,
  sendSessionMessage
} from '../services/AiSession.service.js';
import { decideSessionPrice } from '../services/AiPriceDecision.service.js';
import { decideSessionDiagnosis } from '../services/AiDiagnosisDecision.service.js';
import { normalizeUuid } from '../validators/aiRequest.validator.js';

const respondError = (res, error, correlationId) => {
  if (!(error instanceof AiError)) {
    console.error('[ai-job-assistant] Unexpected request failure.', {
      correlation_id: correlationId || null,
      error: error?.message || 'Unknown error'
    });
  }
  const status = error instanceof AiError ? error.httpStatus : 500;
  return res.status(status).json({
    EM: error instanceof AiError ? error.message : 'Internal server error.',
    EC: status,
    code: error instanceof AiError ? error.code : 'INTERNAL_SERVER_ERROR',
    DT: error instanceof AiError ? error.details : ''
  });
};

const handleCreateSession = async (req, res) => {
  try {
    const result = await createSession({
      customerId: req.user.id,
      body: req.body || {},
      correlationId: req.correlationId
    });
    const data = result?.data || result;
    return res.status(201).json({
      EM: 'AI assistant session created successfully.',
      EC: 0,
      code: 'AI_SESSION_CREATED',
      DT: data
    });
  } catch (error) {
    return respondError(res, error, req.correlationId);
  }
};

const handleGetSession = async (req, res) => {
  try {
    const data = await getSession({
      customerId: req.user.id,
      sessionId: normalizeUuid(req.params.sessionId, 'sessionId')
    });
    return res.status(200).json({
      EM: 'AI assistant session retrieved successfully.',
      EC: 0,
      code: 'AI_SESSION_RETRIEVED',
      DT: data
    });
  } catch (error) {
    return respondError(res, error, req.correlationId);
  }
};

const handleSendMessage = async (req, res) => {
  try {
    const result = await sendSessionMessage({
      customerId: req.user.id,
      sessionId: normalizeUuid(req.params.sessionId, 'sessionId'),
      body: req.body || {},
      correlationId: req.correlationId
    });
    return res.status(200).json({
      EM: result.replayed
        ? 'AI message replayed successfully.'
        : 'AI message processed successfully.',
      EC: 0,
      code: result.replayed ? 'AI_MESSAGE_REPLAYED' : 'AI_MESSAGE_PROCESSED',
      DT: result.data
    });
  } catch (error) {
    return respondError(res, error, req.correlationId);
  }
};

const handlePriceDecision = async (req, res) => {
  try {
    const result = await decideSessionPrice({
      customerId: req.user.id,
      sessionId: normalizeUuid(req.params.sessionId, 'sessionId'),
      body: req.body || {},
      correlationId: req.correlationId
    });
    return res.status(200).json({
      EM: result.replayed
        ? 'AI price decision replayed successfully.'
        : 'AI price decision saved successfully.',
      EC: 0,
      code: result.replayed
        ? 'AI_PRICE_DECISION_REPLAYED'
        : 'AI_PRICE_DECISION_SAVED',
      DT: result.data
    });
  } catch (error) {
    return respondError(res, error, req.correlationId);
  }
};

const handleDiagnosisDecision = async (req, res) => {
  try {
    const result = await decideSessionDiagnosis({
      customerId: req.user.id,
      sessionId: normalizeUuid(req.params.sessionId, 'sessionId'),
      body: req.body || {}
    });
    return res.status(200).json({
      EM: 'AI diagnosis decision saved successfully.',
      EC: 0,
      code: 'AI_DIAGNOSIS_DECISION_SAVED',
      DT: result.data
    });
  } catch (error) {
    return respondError(res, error, req.correlationId);
  }
};

// Hàm xử lý khi người dùng muốn hủy bỏ phiên làm việc AI hiện tại.
const handleAbandonSession = async (req, res) => {
  try {
    const result = await abandonSession({
      customerId: req.user.id,
      sessionId: normalizeUuid(req.params.sessionId, 'sessionId'),
      expectedRevision: req.body?.expected_revision
    });
    return res.status(200).json({
      EM: 'AI assistant session abandoned successfully.',
      EC: 0,
      code: result.replayed ? 'AI_SESSION_ABANDON_REPLAYED' : 'AI_SESSION_ABANDONED',
      DT: result.data
    });
  } catch (error) {
    return respondError(res, error, req.correlationId);
  }
};

export {
  handleAbandonSession,
  handleCreateSession,
  handleDiagnosisDecision,
  handleGetSession,
  handlePriceDecision,
  handleSendMessage
};
