import { randomUUID } from 'node:crypto';
import { Op } from 'sequelize';
import db from '../../../core/database/connection.js';
import User from '../../identity/models/User.model.js';
import Service from '../../matchmaking/models/Service.model.js';
import AiAssistantSession from '../models/AiAssistantSession.model.js';
import AiAssistantMessage from '../models/AiAssistantMessage.model.js';
import {
  AI_ACTIVE_SESSION_STATUSES,
  AI_TERMINAL_SESSION_STATUSES
} from '../constants/ai.constants.js';
import { getAiConfig } from '../config/ai.config.js';
import AiError from '../utils/AiError.js';
import {
  assertPlainObject,
  normalizeClientMessageId,
  normalizeCustomerText,
  normalizeExpectedRevision
} from '../validators/aiRequest.validator.js';
import { analyzeConversation } from '../providers/Gemini.provider.js';
import { estimateHistoricalPrice } from './HistoricalPrice.service.js';

const providerStatus = (message) => message?.provider_metadata?.status || null;
const isExpired = (session) => new Date(session.expires_at).getTime() <= Date.now();

const safeEstimate = (estimate) => {
  if (!estimate || typeof estimate !== 'object') return null;
  return {
    suggested_min_amount: estimate.suggested_min_amount ?? null,
    suggested_typical_amount: estimate.suggested_typical_amount ?? null,
    suggested_max_amount: estimate.suggested_max_amount ?? null,
    confidence: estimate.confidence,
    sample_count: Number(estimate.sample_count || 0),
    candidate_count: Number(estimate.candidate_count || 0),
    pricing_basis: estimate.pricing_basis,
    explanation_code: estimate.explanation_code,
    generated_at: estimate.generated_at || null
  };
};

const buildFormDraft = (session, service) => ({
  service_id: service?.id || null,
  service: service ? {
    id: service.id,
    service_code: service.service_code,
    name: service.name
  } : null,
  issue_description: session.structured_state?.issue_description || null,
  estimated_budget_min: session.selected_budget?.budget_min || null,
  estimated_budget_max: session.selected_budget?.budget_max || null
});

const safeSelectedBudget = (selectedBudget) => {
  if (!selectedBudget || typeof selectedBudget !== 'object') return null;
  return {
    budget_min: selectedBudget.budget_min ?? null,
    budget_max: selectedBudget.budget_max ?? null,
    customer_decision: selectedBudget.customer_decision || null
  };
};

const allowedActions = (session, config) => {
  if (AI_TERMINAL_SESSION_STATUSES.includes(session.status)) return [];
  if (session.status === 'DRAFT_READY') return ['APPLY_TO_JOB', 'ABANDON_SESSION'];
  if (session.status === 'ESTIMATE_PRESENTED') {
    const actions = [
      'USE_OWN_BUDGET',
      'CONTINUE_WITHOUT_ESTIMATE',
      'ABANDON_SESSION'
    ];
    if (session.latest_estimate?.suggested_min_amount) actions.unshift('ACCEPT_SUGGESTION');
    if (session.recalculation_count < config.maxRecalculations
      && session.turn_count < config.maxTurns) {
      actions.push('RECALCULATE');
    }
    return actions;
  }
  return session.turn_count < config.maxTurns
    ? ['SEND_MESSAGE', 'ABANDON_SESSION']
    : ['ABANDON_SESSION'];
};

const getSessionDto = async (sessionOrId, customerId) => {
  const session = typeof sessionOrId === 'string'
    ? await AiAssistantSession.findOne({
      where: { id: sessionOrId, customer_id: customerId }
    })
    : sessionOrId;
  if (!session || session.customer_id !== customerId) {
    throw new AiError('AI assistant session not found.', 404, 'AI_SESSION_NOT_FOUND');
  }
  const [service, messages] = await Promise.all([
    session.detected_service_id
      ? Service.findByPk(session.detected_service_id, {
        attributes: ['id', 'service_code', 'name', 'is_active']
      })
      : null,
    AiAssistantMessage.findAll({
      where: { session_id: session.id },
      attributes: [
        'id',
        'sender',
        'message_text',
        'sequence',
        'client_message_id',
        'provider_metadata',
        'createdAt'
      ],
      order: [['sequence', 'ASC']]
    })
  ]);
  const config = getAiConfig();
  return {
    session_id: session.id,
    status: session.status,
    stage: session.stage,
    revision: Number(session.revision),
    service: service ? {
      id: service.id,
      service_code: service.service_code,
      name: service.name,
      is_active: Boolean(service.is_active)
    } : null,
    problem_summary: session.problem_summary,
    structured_draft: session.structured_state || {},
    messages: messages.map((message) => ({
      message_id: message.id,
      client_message_id: message.sender === 'CUSTOMER'
        ? message.client_message_id
        : null,
      sender: message.sender,
      message: message.message_text,
      sequence: message.sequence,
      delivery_status: message.sender === 'CUSTOMER'
        ? providerStatus(message)
        : 'COMPLETED',
      created_at: message.createdAt
    })),
    latest_estimate: safeEstimate(session.latest_estimate),
    selected_budget: safeSelectedBudget(session.selected_budget),
    form_draft: buildFormDraft(session, service),
    allowed_actions: allowedActions(session, config),
    remaining_turns: Math.max(0, config.maxTurns - Number(session.turn_count)),
    remaining_recalculations: Math.max(
      0,
      config.maxRecalculations - Number(session.recalculation_count)
    ),
    expires_at: session.expires_at,
    applied_job_id: session.status === 'APPLIED_TO_JOB'
      ? session.applied_job_id
      : null,
    created_at: session.createdAt,
    updated_at: session.updatedAt
  };
};

const expireOwnedSession = async (sessionId, customerId) => {
  const result = await db.transaction(async (transaction) => {
    const session = await AiAssistantSession.findOne({
      where: { id: sessionId, customer_id: customerId },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!session) return { missing: true };
    if (isExpired(session) && !AI_TERMINAL_SESSION_STATUSES.includes(session.status)) {
      await session.update({
        status: 'EXPIRED',
        revision: Number(session.revision) + 1
      }, { transaction });
    }
    return { sessionId: session.id };
  });
  if (result.missing) {
    throw new AiError('AI assistant session not found.', 404, 'AI_SESSION_NOT_FOUND');
  }
  return AiAssistantSession.findByPk(result.sessionId);
};

const createSession = async ({ customerId, body = {}, correlationId }) => {
  assertPlainObject(body, ['initial_message']);
  const initialMessage = body.initial_message === undefined
    ? null
    : normalizeCustomerText(body.initial_message, 'initial_message');
  const config = getAiConfig();
  const session = await db.transaction(async (transaction) => {
    const customer = await User.findByPk(customerId, {
      attributes: ['id', 'role', 'is_active'],
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!customer || customer.role !== 'CUSTOMER' || !customer.is_active) {
      throw new AiError('Active Customer account required.', 403, 'AI_CUSTOMER_REQUIRED');
    }
    await AiAssistantSession.update(
      { status: 'EXPIRED' },
      {
        where: {
          customer_id: customerId,
          status: { [Op.in]: AI_ACTIVE_SESSION_STATUSES },
          expires_at: { [Op.lte]: new Date() }
        },
        transaction
      }
    );
    const activeCount = await AiAssistantSession.count({
      where: {
        customer_id: customerId,
        status: { [Op.in]: AI_ACTIVE_SESSION_STATUSES }
      },
      transaction
    });
    if (activeCount >= config.maxActiveSessionsPerCustomer) {
      throw new AiError(
        'Maximum active AI assistant sessions reached.',
        409,
        'AI_ACTIVE_SESSION_LIMIT_REACHED'
      );
    }
    return AiAssistantSession.create({
      customer_id: customerId,
      status: 'ACTIVE',
      stage: 'COLLECTING_PROBLEM',
      structured_state: {},
      revision: 0,
      turn_count: 0,
      recalculation_count: 0,
      provider: 'GEMINI',
      model: config.model || null,
      prompt_version: config.promptVersion,
      estimator_version: config.estimatorVersion,
      expires_at: new Date(Date.now() + (config.sessionTtlMinutes * 60 * 1000))
    }, { transaction });
  });

  if (!initialMessage) return getSessionDto(session, customerId);
  return sendSessionMessage({
    customerId,
    sessionId: session.id,
    body: {
      message: initialMessage,
      client_message_id: randomUUID(),
      expected_revision: 0
    },
    correlationId
  });
};

const reserveCustomerMessage = async ({
  customerId,
  sessionId,
  messageText,
  clientMessageId,
  expectedRevision,
  isRecalculation
}) => db.transaction(async (transaction) => {
  const config = getAiConfig();
  const session = await AiAssistantSession.findOne({
    where: { id: sessionId, customer_id: customerId },
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

  const existing = await AiAssistantMessage.findOne({
    where: { session_id: session.id, client_message_id: clientMessageId },
    transaction
  });
  if (existing) {
    if (existing.message_text !== messageText) return { idempotencyConflict: true };
    const status = providerStatus(existing);
    if (status === 'COMPLETED') return { replay: true, sessionId: session.id };
    if (status === 'PROCESSING') return { processing: true };
    if (!['FAILED', 'STALE_IGNORED'].includes(status)) return { processing: true };
    const expectedKind = isRecalculation ? 'RECALCULATION' : 'MESSAGE';
    if (existing.provider_metadata?.kind !== expectedKind) {
      return { idempotencyConflict: true };
    }
    const latestSequence = await AiAssistantMessage.max('sequence', {
      where: { session_id: session.id },
      transaction
    });
    if (Number(latestSequence || 0) !== Number(existing.sequence)) {
      return { invalidState: true };
    }
    if (Number(session.revision) !== expectedRevision) return { revisionConflict: true };
    if (AI_TERMINAL_SESSION_STATUSES.includes(session.status)) return { invalidState: true };
    await existing.update({
      provider_metadata: {
        ...(existing.provider_metadata || {}),
        status: 'PROCESSING',
        attempt: Number(existing.provider_metadata?.attempt || 1) + 1,
        error_code: null
      }
    }, { transaction });
    await session.update({ revision: Number(session.revision) + 1 }, { transaction });
    return {
      session: session.toJSON(),
      message: existing.toJSON(),
      reservedRevision: Number(session.revision),
      retry: true
    };
  }

  if (Number(session.revision) !== expectedRevision) return { revisionConflict: true };
  if (isRecalculation) {
    if (session.status !== 'ESTIMATE_PRESENTED') return { invalidState: true };
    if (Number(session.recalculation_count) >= config.maxRecalculations) {
      return { maxRecalculations: true };
    }
  } else if (session.status !== 'ACTIVE') {
    return { invalidState: true };
  }
  if (Number(session.turn_count) >= config.maxTurns) return { maxTurns: true };

  const processing = await AiAssistantMessage.findOne({
    where: { session_id: session.id },
    order: [['sequence', 'DESC']],
    transaction
  });
  if (processing?.sender === 'CUSTOMER' && providerStatus(processing) === 'PROCESSING') {
    return { processing: true };
  }

  const currentMaximum = await AiAssistantMessage.max('sequence', {
    where: { session_id: session.id },
    transaction
  });
  const message = await AiAssistantMessage.create({
    session_id: session.id,
    sender: 'CUSTOMER',
    message_text: messageText,
    sequence: Number(currentMaximum || 0) + 1,
    client_message_id: clientMessageId,
    provider_metadata: {
      status: 'PROCESSING',
      attempt: 1,
      kind: isRecalculation ? 'RECALCULATION' : 'MESSAGE'
    }
  }, { transaction });
  await session.update({
    revision: Number(session.revision) + 1,
    turn_count: Number(session.turn_count) + 1,
    recalculation_count: isRecalculation
      ? Number(session.recalculation_count) + 1
      : Number(session.recalculation_count)
  }, { transaction });
  return {
    session: session.toJSON(),
    message: message.toJSON(),
    reservedRevision: Number(session.revision),
    retry: false
  };
});

const markProviderFailure = async ({
  sessionId,
  messageId,
  reservedRevision,
  error
}) => {
  await db.transaction(async (transaction) => {
    const session = await AiAssistantSession.findByPk(sessionId, {
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    const message = await AiAssistantMessage.findByPk(messageId, {
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!session || !message || providerStatus(message) !== 'PROCESSING') return;
    const stale = Number(session.revision) !== reservedRevision
      || AI_TERMINAL_SESSION_STATUSES.includes(session.status);
    await message.update({
      provider_metadata: {
        ...(message.provider_metadata || {}),
        status: stale ? 'STALE_IGNORED' : 'FAILED',
        error_code: stale ? 'AI_SESSION_STATE_CHANGED' : error.code
      }
    }, { transaction });
  });
};

const getPriorCompletedMessages = async (sessionId, beforeSequence, limit) => {
  const rows = await AiAssistantMessage.findAll({
    where: {
      session_id: sessionId,
      sequence: { [Op.lt]: beforeSequence }
    },
    order: [['sequence', 'DESC']],
    limit: limit * 2
  });
  return rows
    .filter((message) => (
      message.sender === 'ASSISTANT'
      || (message.sender === 'CUSTOMER' && providerStatus(message) === 'COMPLETED')
    ))
    .slice(0, limit)
    .reverse()
    .map((message) => ({
      sender: message.sender,
      message_text: message.message_text
    }));
};

const mergeStructuredState = (previous, analysis) => ({
  service_code: analysis.service_code ?? previous?.service_code ?? null,
  issue_description: analysis.form_patch.issue_description
    ?? previous?.issue_description
    ?? null,
  problem_summary: analysis.problem_summary ?? previous?.problem_summary ?? null,
  symptoms: analysis.symptoms,
  keywords: analysis.keywords,
  severity: analysis.severity,
  urgency: analysis.urgency,
  complexity: analysis.complexity,
  missing_information: analysis.missing_information,
  follow_up_questions: analysis.follow_up_questions,
  safety_message: analysis.safety_message
});

const commitProviderResponse = async ({
  customerId,
  sessionId,
  customerMessage,
  reservedRevision,
  analysis,
  providerMetadata,
  resolvedService,
  estimate,
  isRecalculation
}) => db.transaction(async (transaction) => {
  const session = await AiAssistantSession.findOne({
    where: { id: sessionId, customer_id: customerId },
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  const message = await AiAssistantMessage.findByPk(customerMessage.id, {
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  if (!session || !message) return { stale: true };
  if (isExpired(session) && !AI_TERMINAL_SESSION_STATUSES.includes(session.status)) {
    await session.update({
      status: 'EXPIRED',
      revision: Number(session.revision) + 1
    }, { transaction });
    await message.update({
      provider_metadata: {
        ...(message.provider_metadata || {}),
        status: 'STALE_IGNORED',
        error_code: 'AI_SESSION_EXPIRED'
      }
    }, { transaction });
    return { expired: true };
  }
  if (Number(session.revision) !== reservedRevision
    || providerStatus(message) !== 'PROCESSING'
    || AI_TERMINAL_SESSION_STATUSES.includes(session.status)) {
    await message.update({
      provider_metadata: {
        ...(message.provider_metadata || {}),
        status: 'STALE_IGNORED',
        error_code: 'AI_SESSION_STATE_CHANGED'
      }
    }, { transaction });
    return { stale: true };
  }

  let canonicalService = null;
  if (resolvedService) {
    canonicalService = await Service.findOne({
      where: { id: resolvedService.id, is_active: true },
      transaction
    });
  }
  const structuredState = mergeStructuredState(session.structured_state || {}, analysis);
  const ready = analysis.stage === 'READY_FOR_ESTIMATE'
    && canonicalService
    && String(structuredState.problem_summary || '').length >= 10
    && String(structuredState.issue_description || '').length >= 10
    && structuredState.missing_information.length === 0;
  const finalEstimate = ready ? estimate : null;
  const nextStatus = ready ? 'ESTIMATE_PRESENTED' : 'ACTIVE';
  const nextStage = ready
    ? 'ESTIMATE_PRESENTED'
    : analysis.stage === 'NEED_MORE_INFO'
      ? 'CLARIFYING'
      : 'COLLECTING_PROBLEM';

  await AiAssistantMessage.create({
    session_id: session.id,
    sender: 'ASSISTANT',
    message_text: analysis.assistant_message,
    sequence: Number(message.sequence) + 1,
    client_message_id: null,
    provider_metadata: { status: 'COMPLETED' }
  }, { transaction });
  await message.update({
    provider_metadata: {
      ...(message.provider_metadata || {}),
      status: 'COMPLETED',
      error_code: null,
      latency_ms: providerMetadata.latency_ms,
      provider_attempt: providerMetadata.attempt,
      usage: providerMetadata.usage || null
    }
  }, { transaction });
  await session.update({
    status: nextStatus,
    stage: nextStage,
    detected_service_id: canonicalService?.id || null,
    problem_summary: structuredState.problem_summary,
    structured_state: structuredState,
    latest_estimate: finalEstimate,
    selected_budget: isRecalculation ? null : session.selected_budget,
    model: getAiConfig().model || session.model,
    revision: Number(session.revision) + 1
  }, { transaction });
  return { sessionId: session.id };
});

const sendSessionMessage = async ({
  customerId,
  sessionId,
  body,
  correlationId,
  isRecalculation = false
}) => {
  assertPlainObject(
    body,
    isRecalculation
      ? ['message', 'client_message_id', 'expected_revision']
      : ['message', 'client_message_id', 'expected_revision']
  );
  const messageText = normalizeCustomerText(
    body.message,
    isRecalculation ? 'clarification' : 'message'
  );
  const clientMessageId = normalizeClientMessageId(body.client_message_id);
  const expectedRevision = normalizeExpectedRevision(body.expected_revision);
  const reservation = await reserveCustomerMessage({
    customerId,
    sessionId,
    messageText,
    clientMessageId,
    expectedRevision,
    isRecalculation
  });

  if (reservation.missing) throw new AiError('AI assistant session not found.', 404, 'AI_SESSION_NOT_FOUND');
  if (reservation.expired) throw new AiError('AI assistant session has expired.', 410, 'AI_SESSION_EXPIRED');
  if (reservation.idempotencyConflict) throw new AiError('client_message_id was already used with different content.', 409, 'AI_MESSAGE_IDEMPOTENCY_CONFLICT');
  if (reservation.processing) throw new AiError('Another AI message is currently processing.', 409, 'AI_MESSAGE_PROCESSING');
  if (reservation.revisionConflict) throw new AiError('AI session revision changed.', 409, 'AI_SESSION_REVISION_CONFLICT');
  if (reservation.invalidState) throw new AiError('AI session does not allow this action.', 409, 'AI_SESSION_STATE_INVALID');
  if (reservation.maxTurns) throw new AiError('Maximum AI conversation turns reached.', 409, 'AI_MAX_TURNS_REACHED');
  if (reservation.maxRecalculations) throw new AiError('Maximum price recalculations reached.', 409, 'AI_MAX_RECALCULATIONS_REACHED');
  if (reservation.replay) {
    return {
      replayed: true,
      data: await getSessionDto(reservation.sessionId, customerId)
    };
  }

  const config = getAiConfig();
  try {
    const [serviceCatalog, recentMessages] = await Promise.all([
      Service.findAll({
        where: { is_active: true },
        attributes: ['id', 'service_code', 'name'],
        order: [['name', 'ASC'], ['id', 'ASC']]
      }),
      getPriorCompletedMessages(
        sessionId,
        reservation.message.sequence,
        config.maxContextMessages
      )
    ]);
    const providerResult = await analyzeConversation({
      serviceCatalog,
      structuredState: reservation.session.structured_state || {},
      recentMessages,
      customerMessage: messageText,
      correlationId,
      sessionId
    });
    const requestedServiceCode = providerResult.data.service_code
      ?? reservation.session.structured_state?.service_code
      ?? null;
    const resolvedService = requestedServiceCode
      ? await Service.findOne({
        where: {
          service_code: requestedServiceCode,
          is_active: true
        },
        attributes: ['id', 'service_code', 'name']
      })
      : null;
    const prospectiveState = mergeStructuredState(
      reservation.session.structured_state || {},
      providerResult.data
    );
    const ready = providerResult.data.stage === 'READY_FOR_ESTIMATE'
      && resolvedService
      && String(prospectiveState.problem_summary || '').length >= 10
      && String(prospectiveState.issue_description || '').length >= 10
      && prospectiveState.missing_information.length === 0;
    const estimate = ready
      ? await estimateHistoricalPrice({
        serviceId: resolvedService.id,
        currentState: prospectiveState
      })
      : null;
    const committed = await commitProviderResponse({
      customerId,
      sessionId,
      customerMessage: reservation.message,
      reservedRevision: reservation.reservedRevision,
      analysis: providerResult.data,
      providerMetadata: providerResult.metadata,
      resolvedService,
      estimate,
      isRecalculation
    });
    if (committed.expired) {
      throw new AiError('AI assistant session has expired.', 410, 'AI_SESSION_EXPIRED');
    }
    if (committed.stale) {
      throw new AiError('AI session changed while processing.', 409, 'AI_SESSION_STATE_CHANGED');
    }
    return {
      replayed: false,
      data: await getSessionDto(committed.sessionId, customerId)
    };
  } catch (error) {
    const mapped = error instanceof AiError
      ? error
      : new AiError('The AI assistant is temporarily unavailable.', 503, 'AI_PROVIDER_UNAVAILABLE');
    await markProviderFailure({
      sessionId,
      messageId: reservation.message.id,
      reservedRevision: reservation.reservedRevision,
      error: mapped
    });
    mapped.details = {
      session_id: sessionId,
      customer_message_id: reservation.message.id,
      client_message_id: clientMessageId,
      revision: reservation.reservedRevision,
      retryable: [
        'AI_PROVIDER_UNAVAILABLE',
        'AI_PROVIDER_RATE_LIMITED',
        'AI_PROVIDER_TIMEOUT',
        'AI_RESPONSE_INVALID'
      ].includes(mapped.code)
    };
    throw mapped;
  }
};

const getSession = async ({ customerId, sessionId }) => {
  const session = await expireOwnedSession(sessionId, customerId);
  return getSessionDto(session, customerId);
};

const abandonSession = async ({ customerId, sessionId, expectedRevision }) => {
  const revision = normalizeExpectedRevision(expectedRevision);
  const result = await db.transaction(async (transaction) => {
    const session = await AiAssistantSession.findOne({
      where: { id: sessionId, customer_id: customerId },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!session) return { missing: true };
    if (session.status === 'ABANDONED') return { replay: true, sessionId: session.id };
    if (isExpired(session) && !AI_TERMINAL_SESSION_STATUSES.includes(session.status)) {
      await session.update({
        status: 'EXPIRED',
        revision: Number(session.revision) + 1
      }, { transaction });
      return { expired: true };
    }
    if (session.status === 'APPLIED_TO_JOB') return { invalidState: true };
    if (Number(session.revision) !== revision) return { revisionConflict: true };
    const latest = await AiAssistantMessage.findOne({
      where: { session_id: session.id },
      order: [['sequence', 'DESC']],
      transaction
    });
    if (latest?.sender === 'CUSTOMER' && providerStatus(latest) === 'PROCESSING') {
      await latest.update({
        provider_metadata: {
          ...(latest.provider_metadata || {}),
          status: 'STALE_IGNORED',
          error_code: 'AI_SESSION_ABANDONED'
        }
      }, { transaction });
    }
    await session.update({
      status: 'ABANDONED',
      revision: Number(session.revision) + 1
    }, { transaction });
    return { sessionId: session.id };
  });
  if (result.missing) throw new AiError('AI assistant session not found.', 404, 'AI_SESSION_NOT_FOUND');
  if (result.expired) throw new AiError('AI assistant session has expired.', 410, 'AI_SESSION_EXPIRED');
  if (result.invalidState) throw new AiError('Applied session cannot be abandoned.', 409, 'AI_SESSION_STATE_INVALID');
  if (result.revisionConflict) throw new AiError('AI session revision changed.', 409, 'AI_SESSION_REVISION_CONFLICT');
  return {
    replayed: Boolean(result.replay),
    data: await getSessionDto(result.sessionId, customerId)
  };
};

export {
  abandonSession,
  createSession,
  getSession,
  getSessionDto,
  sendSessionMessage
};
