import { createHash } from 'node:crypto';
import db from '../../../core/database/connection.js';
import AiAssistantSession from '../models/AiAssistantSession.model.js';
import AiAssistantMessage from '../models/AiAssistantMessage.model.js';
import {
  AI_PRICE_DECISIONS,
  AI_SNAPSHOT_DECISIONS,
  AI_TERMINAL_SESSION_STATUSES
} from '../constants/ai.constants.js';
import AiError from '../utils/AiError.js';
import {
  MAX_JOB_BUDGET,
  parsePositiveVndInteger
} from '../utils/vndEstimator.util.js';
import {
  assertPlainObject,
  normalizeCustomerText,
  normalizeExpectedRevision
} from '../validators/aiRequest.validator.js';
import { getSessionDto, sendSessionMessage } from './AiSession.service.js';

const fingerprint = (value) => createHash('sha256')
  .update(JSON.stringify(value))
  .digest('hex');

const normalizeOwnBudget = (minimum, maximum) => {
  const parsedMinimum = parsePositiveVndInteger(minimum);
  const parsedMaximum = parsePositiveVndInteger(maximum);
  if (parsedMinimum === null || parsedMaximum === null) {
    throw new AiError(
      `budget_min and budget_max must be positive VND integer strings not exceeding ${MAX_JOB_BUDGET}.`,
      400,
      'AI_BUDGET_INVALID'
    );
  }
  if (parsedMaximum < parsedMinimum) {
    throw new AiError(
      'budget_max must be greater than or equal to budget_min.',
      400,
      'AI_BUDGET_INVALID'
    );
  }
  return {
    budget_min: parsedMinimum.toString(),
    budget_max: parsedMaximum.toString()
  };
};

const decideSessionPrice = async ({
  customerId,
  sessionId,
  body,
  correlationId
}) => {
  assertPlainObject(body, [
    'action',
    'expected_revision',
    'clarification',
    'client_message_id',
    'budget_min',
    'budget_max'
  ]);
  if (!AI_PRICE_DECISIONS.includes(body.action)) {
    throw new AiError('AI price decision is invalid.', 400, 'AI_PRICE_DECISION_INVALID');
  }
  const expectedRevision = normalizeExpectedRevision(body.expected_revision);
  if (body.action === 'RECALCULATE') {
    if (body.budget_min !== undefined || body.budget_max !== undefined) {
      throw new AiError(
        'RECALCULATE does not accept budget fields.',
        400,
        'AI_PRICE_DECISION_INVALID'
      );
    }
    const clarification = normalizeCustomerText(body.clarification, 'clarification');
    const result = await sendSessionMessage({
      customerId,
      sessionId,
      body: {
        message: clarification,
        client_message_id: body.client_message_id,
        expected_revision: expectedRevision
      },
      correlationId,
      isRecalculation: true
    });
    return result;
  }

  const ownBudget = body.action === 'USE_OWN_BUDGET'
    ? normalizeOwnBudget(body.budget_min, body.budget_max)
    : null;
  const invalidFields = body.action === 'USE_OWN_BUDGET'
    ? [body.clarification, body.client_message_id]
    : [body.budget_min, body.budget_max, body.clarification, body.client_message_id];
  if (invalidFields.some((entry) => entry !== undefined)) {
    throw new AiError(
      'The selected action contains unsupported fields.',
      400,
      'AI_PRICE_DECISION_INVALID'
    );
  }
  const requestFingerprint = fingerprint({
    action: body.action,
    budget_min: ownBudget?.budget_min || null,
    budget_max: ownBudget?.budget_max || null
  });

  const result = await db.transaction(async (transaction) => {
    const session = await AiAssistantSession.findOne({
      where: { id: sessionId, customer_id: customerId },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!session) return { missing: true };
    if (session.status === 'DRAFT_READY') {
      if (session.selected_budget?.decision_fingerprint === requestFingerprint) {
        return { replay: true, sessionId: session.id };
      }
      return { invalidState: true };
    }
    if (new Date(session.expires_at).getTime() <= Date.now()
      && !AI_TERMINAL_SESSION_STATUSES.includes(session.status)) {
      await session.update({
        status: 'EXPIRED',
        revision: Number(session.revision) + 1
      }, { transaction });
      return { expired: true };
    }
    if (session.status !== 'ESTIMATE_PRESENTED') return { invalidState: true };
    if (Number(session.revision) !== expectedRevision) return { revisionConflict: true };

    const latestMessage = await AiAssistantMessage.findOne({
      where: { session_id: session.id },
      order: [['sequence', 'DESC']],
      transaction
    });
    if (latestMessage?.sender === 'CUSTOMER'
      && latestMessage.provider_metadata?.status === 'PROCESSING') {
      return { processing: true };
    }
    if (body.action === 'ACCEPT_SUGGESTION'
      && !session.latest_estimate?.suggested_min_amount) {
      return { estimateUnavailable: true };
    }

    // Xác định ngân sách được chọn dựa trên hành động của khách hàng
    let selectedBudget;
    if (body.action === 'ACCEPT_SUGGESTION') {
      selectedBudget = {
        budget_min: session.latest_estimate.suggested_min_amount,
        budget_max: session.latest_estimate.suggested_max_amount 
      };
    } else if (body.action === 'USE_OWN_BUDGET') {
      selectedBudget = ownBudget;
    } else {
      selectedBudget = { budget_min: null, budget_max: null };
    }
    // Cập nhật phiên làm việc với quyết định của khách hàng và lưu trữ ngân sách được chọn
    await session.update({
      status: 'DRAFT_READY',
      stage: 'DRAFT_READY',
      selected_budget: {
        ...selectedBudget,
        customer_decision: AI_SNAPSHOT_DECISIONS[body.action],
        decision_action: body.action,
        decision_fingerprint: requestFingerprint
      },
      revision: Number(session.revision) + 1
    }, { transaction });
    return { sessionId: session.id };
  });

  if (result.missing) throw new AiError('AI assistant session not found.', 404, 'AI_SESSION_NOT_FOUND');
  if (result.expired) throw new AiError('AI assistant session has expired.', 410, 'AI_SESSION_EXPIRED');
  if (result.processing) throw new AiError('AI message is still processing.', 409, 'AI_MESSAGE_PROCESSING');
  if (result.revisionConflict) throw new AiError('AI session revision changed.', 409, 'AI_SESSION_REVISION_CONFLICT');
  if (result.invalidState) throw new AiError('AI session does not allow this decision.', 409, 'AI_SESSION_STATE_INVALID');
  if (result.estimateUnavailable) throw new AiError('No AI price range is available to accept.', 409, 'AI_ESTIMATE_NOT_AVAILABLE');
  return {
    replayed: Boolean(result.replay),
    data: await getSessionDto(result.sessionId, customerId)
  };
};

export { decideSessionPrice, normalizeOwnBudget };
