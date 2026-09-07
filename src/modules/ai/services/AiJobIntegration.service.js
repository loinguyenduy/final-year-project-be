import AiAssistantSession from '../models/AiAssistantSession.model.js';
import JobAiPriceSuggestion from '../models/JobAiPriceSuggestion.model.js';
import AiError from '../utils/AiError.js';
import { UUID_PATTERN } from '../validators/aiRequest.validator.js';

const lockApplicableAiSession = async ({
  sessionId,
  customerId,
  serviceId,
  transaction
}) => {
  if (typeof sessionId !== 'string' || !UUID_PATTERN.test(sessionId.trim())) {
    throw new AiError(
      'ai_assistant_session_id must be a UUID.',
      400,
      'VALIDATION_ERROR'
    );
  }
  const session = await AiAssistantSession.findOne({
    where: { id: sessionId.trim(), customer_id: customerId },
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  if (!session) {
    throw new AiError('AI assistant session not found.', 404, 'AI_SESSION_NOT_FOUND');
  }
  if (session.status === 'APPLIED_TO_JOB' || session.applied_job_id) {
    throw new AiError(
      'AI assistant session has already been applied to a Job.',
      409,
      'AI_SESSION_ALREADY_APPLIED',
      { applied_job_id: session.applied_job_id || null }
    );
  }
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    throw new AiError('AI assistant session has expired.', 410, 'AI_SESSION_EXPIRED');
  }
  if (session.status !== 'DRAFT_READY') {
    throw new AiError(
      'AI assistant session is not ready to create a Job.',
      409,
      'AI_SESSION_NOT_DRAFT_READY'
    );
  }
  if (!session.detected_service_id
    || String(session.detected_service_id) !== String(serviceId)) {
    throw new AiError(
      'The selected Service differs from the AI assistant Service. Submit without the AI session to continue manually.',
      409,
      'AI_SESSION_SERVICE_MISMATCH'
    );
  }
  if (!session.selected_budget?.customer_decision) {
    throw new AiError(
      'AI assistant price decision is incomplete.',
      409,
      'AI_SESSION_NOT_DRAFT_READY'
    );
  }
  return session;
};

const createJobAiSnapshot = async ({ session, job, transaction }) => {
  const estimate = session.latest_estimate || {};
  const selectedBudget = session.selected_budget || {};
  await JobAiPriceSuggestion.create({
    job_id: job.id,
    assistant_session_id: session.id,
    service_id: session.detected_service_id,
    problem_summary: session.problem_summary,
    complexity: session.structured_state?.complexity || 'UNKNOWN',
    suggested_min_amount: estimate.suggested_min_amount ?? null,
    suggested_typical_amount: estimate.suggested_typical_amount ?? null,
    suggested_max_amount: estimate.suggested_max_amount ?? null,
    confidence: estimate.confidence || 'INSUFFICIENT_DATA',
    sample_count: Number(estimate.sample_count || 0),
    candidate_count: Number(estimate.candidate_count || 0),
    customer_decision: selectedBudget.customer_decision,
    customer_budget_min: selectedBudget.budget_min ?? null,
    customer_budget_max: selectedBudget.budget_max ?? null,
    prompt_version: session.prompt_version,
    estimator_version: session.estimator_version
  }, { transaction });
  await session.update({
    status: 'APPLIED_TO_JOB',
    applied_job_id: job.id,
    revision: Number(session.revision) + 1
  }, { transaction });
};

const SAFE_GUIDANCE_ATTRIBUTES = Object.freeze([
  'suggested_min_amount',
  'suggested_typical_amount',
  'suggested_max_amount',
  'confidence',
  'sample_count',
  'customer_decision'
]);

const buildSafeAiPriceGuidance = (suggestion) => {
  if (!suggestion) return null;
  const plain = typeof suggestion.toJSON === 'function'
    ? suggestion.toJSON()
    : suggestion;
  return {
    suggested_min_amount: plain.suggested_min_amount ?? null,
    suggested_typical_amount: plain.suggested_typical_amount ?? null,
    suggested_max_amount: plain.suggested_max_amount ?? null,
    confidence: plain.confidence,
    sample_count: Number(plain.sample_count || 0),
    pricing_basis: 'HISTORICAL_SELECTED_BIDS',
    customer_decision: plain.customer_decision
  };
};

export {
  SAFE_GUIDANCE_ATTRIBUTES,
  buildSafeAiPriceGuidance,
  createJobAiSnapshot,
  lockApplicableAiSession
};
