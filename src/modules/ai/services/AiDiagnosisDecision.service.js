import db from '../../../core/database/connection.js';
import Service from '../../matchmaking/models/Service.model.js';
import AiAssistantMessage from '../models/AiAssistantMessage.model.js';
import AiAssistantSession from '../models/AiAssistantSession.model.js';
import {
  AI_DIAGNOSIS_ACTIONS,
  AI_TERMINAL_SESSION_STATUSES
} from '../constants/ai.constants.js';
import { getAiConfig } from '../config/ai.config.js';
import AiError from '../utils/AiError.js';
import {
  assertPlainObject,
  normalizeExpectedRevision
} from '../validators/aiRequest.validator.js';
import { estimateHistoricalPrice } from './HistoricalPrice.service.js';
import { getSessionDto } from './AiSession.service.js';

const isExpired = (session) => new Date(session.expires_at).getTime() <= Date.now();

const localizedMessage = (language, key) => {
  const messages = {
    VI: {
      CONFIRMED: 'Thông tin đã được xác nhận. Bạn có thể xem hướng dẫn giá và chọn cách tiếp tục.',
      CORRECTION: 'Bạn muốn bổ sung hoặc chỉnh sửa thông tin nào? Hãy mô tả thay đổi trong ô trò chuyện.'
    },
    EN: {
      CONFIRMED: 'The information is confirmed. Review the price guidance and choose how to continue.',
      CORRECTION: 'What information would you like to add or correct? Describe the change in the conversation box.'
    }
  };
  return messages[language === 'EN' ? 'EN' : 'VI'][key];
};

const appendAssistantMessage = async ({
  session,
  messageText,
  transaction
}) => {
  const maximumSequence = await AiAssistantMessage.max('sequence', {
    where: { session_id: session.id },
    transaction
  });
  await AiAssistantMessage.create({
    session_id: session.id,
    sender: 'ASSISTANT',
    message_text: messageText,
    sequence: Number(maximumSequence || 0) + 1,
    client_message_id: null,
    provider_metadata: {
      status: 'COMPLETED',
      kind: 'DIAGNOSIS_DECISION'
    }
  }, { transaction });
};

const validateLockedSession = ({
  session,
  expectedRevision
}) => {
  if (!session) return { missing: true };
  if (isExpired(session) && !AI_TERMINAL_SESSION_STATUSES.includes(session.status)) {
    return { expired: true };
  }
  if (Number(session.revision) !== expectedRevision) return { revisionConflict: true };
  return null;
};

const correctDiagnosis = async ({
  customerId,
  sessionId,
  expectedRevision
}) => {
  const result = await db.transaction(async (transaction) => {
    const session = await AiAssistantSession.findOne({
      where: { id: sessionId, customer_id: customerId },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    const invalid = validateLockedSession({ session, expectedRevision });
    if (invalid?.expired) {
      await session.update({
        status: 'EXPIRED',
        revision: Number(session.revision) + 1
      }, { transaction });
    }
    if (invalid) return invalid;
    if (!['READY_FOR_ESTIMATE', 'ESTIMATE_PRESENTED', 'DRAFT_READY'].includes(session.status)) {
      return { invalidState: true };
    }
    if (Number(session.turn_count) >= getAiConfig().maxTurns) return { maxTurns: true };

    const language = session.structured_state?.conversation_language || 'VI';
    await appendAssistantMessage({
      session,
      messageText: localizedMessage(language, 'CORRECTION'),
      transaction
    });
    await session.update({
      status: 'ACTIVE',
      stage: 'CLARIFYING',
      structured_state: {
        ...(session.structured_state || {}),
        diagnosis_confirmation: 'CORRECTING'
      },
      latest_estimate: null,
      selected_budget: null,
      revision: Number(session.revision) + 1
    }, { transaction });
    return { sessionId: session.id };
  });
  return result;
};

// chuẩn bị xác nhận chẩn đoán cho phiên làm việc, kiểm tra trạng thái và khóa phiên.
const prepareDiagnosisConfirmation = async ({
  customerId,
  sessionId,
  expectedRevision
}) => db.transaction(async (transaction) => {
  const session = await AiAssistantSession.findOne({
    where: { id: sessionId, customer_id: customerId },
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  const invalid = validateLockedSession({ session, expectedRevision });
  if (invalid?.expired) {
    await session.update({
      status: 'EXPIRED',
      revision: Number(session.revision) + 1
    }, { transaction });
  }
  if (invalid) return invalid;
  if (session.status !== 'READY_FOR_ESTIMATE'
    || session.structured_state?.diagnosis_confirmation !== 'PENDING') {
    return { invalidState: true };
  }
  const service = await Service.findOne({
    where: { id: session.detected_service_id, is_active: true },
    attributes: ['id'],
    transaction
  });
  if (!service) return { invalidState: true };
  return {
    sessionId: session.id,
    serviceId: service.id,
    revision: Number(session.revision),
    structuredState: session.structured_state || {}
  };
});

const commitDiagnosisConfirmation = async ({
  customerId,
  prepared,
  estimate
}) => db.transaction(async (transaction) => {
  const session = await AiAssistantSession.findOne({
    where: { id: prepared.sessionId, customer_id: customerId },
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  if (!session) return { missing: true };
  if (isExpired(session) && !AI_TERMINAL_SESSION_STATUSES.includes(session.status)) {
    await session.update({
      status: 'EXPIRED',
      revision: Number(session.revision) + 1
    }, { transaction });
    return { expired: true };
  }
  if (Number(session.revision) !== prepared.revision
    || session.status !== 'READY_FOR_ESTIMATE'
    || session.structured_state?.diagnosis_confirmation !== 'PENDING') {
    return { revisionConflict: true };
  }

  const language = session.structured_state?.conversation_language || 'VI';
  await appendAssistantMessage({
    session,
    messageText: localizedMessage(language, 'CONFIRMED'),
    transaction
  });
  await session.update({
    status: 'ESTIMATE_PRESENTED',
    stage: 'ESTIMATE_PRESENTED',
    structured_state: {
      ...(session.structured_state || {}),
      diagnosis_confirmation: 'CONFIRMED'
    },
    latest_estimate: estimate,
    selected_budget: null,
    revision: Number(session.revision) + 1
  }, { transaction });
  return { sessionId: session.id };
});

// Xử lý quyết định chẩn đoán của phiên làm việc
const decideSessionDiagnosis = async ({
  customerId,
  sessionId,
  body
}) => {
  assertPlainObject(body, ['action', 'expected_revision']);
  if (!AI_DIAGNOSIS_ACTIONS.includes(body.action)) {
    throw new AiError(
      'AI diagnosis decision is invalid.',
      400,
      'AI_DIAGNOSIS_DECISION_INVALID'
    );
  }
  const expectedRevision = normalizeExpectedRevision(body.expected_revision);
  let result;

  if (body.action === 'CORRECT_DIAGNOSIS') {
    result = await correctDiagnosis({ customerId, sessionId, expectedRevision });
  } else {
    // Nếu hành động là xác nhận chẩn đoán, chuẩn bị và xác nhận chẩn đoán
    const prepared = await prepareDiagnosisConfirmation({
      customerId,
      sessionId,
      expectedRevision
    });
    if (prepared.missing || prepared.expired || prepared.revisionConflict || prepared.invalidState) {
      result = prepared;
    } else {
      // Nếu hợp lệ, ước lượng giá lịch sử và xác nhận chẩn đoán
      const estimate = await estimateHistoricalPrice({
        serviceId: prepared.serviceId,
        currentState: prepared.structuredState
      });
      // xác nhận chẩn đoán và lưu trữ ước lượng giá
      result = await commitDiagnosisConfirmation({
        customerId,
        prepared,
        estimate
      });
    }
  }

  if (result.missing) {
    throw new AiError('AI assistant session not found.', 404, 'AI_SESSION_NOT_FOUND');
  }
  if (result.expired) {
    throw new AiError('AI assistant session has expired.', 410, 'AI_SESSION_EXPIRED');
  }
  if (result.revisionConflict) {
    throw new AiError('AI session revision changed.', 409, 'AI_SESSION_REVISION_CONFLICT');
  }
  if (result.invalidState) {
    throw new AiError(
      'AI session does not allow this diagnosis decision.',
      409,
      'AI_SESSION_STATE_INVALID'
    );
  }
  if (result.maxTurns) {
    throw new AiError(
      'Maximum AI conversation turns reached.',
      409,
      'AI_MAX_TURNS_REACHED'
    );
  }
  return {
    data: await getSessionDto(result.sessionId, customerId)
  };
};

export { decideSessionDiagnosis };
