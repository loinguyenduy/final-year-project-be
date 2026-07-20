import { createHash } from 'node:crypto';
import { ACTION_REASON_CODES, REVIEW_ACTIONS } from '../constants/adminReview.constants.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const HTML_TAG_PATTERN = /<\/?[a-z][^>]*>/i;

class AdminReviewError extends Error {
  constructor(message, status = 400, code = 'VALIDATION_ERROR', data = '') {
    super(message);
    this.name = 'AdminReviewError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

const isValidUuid = (value) => UUID_PATTERN.test(String(value || ''));

const validateDecisionPayload = (payload, {
  allowedDecisions,
  requireText = false
} = {}) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AdminReviewError('Decision body must be an object.');
  }
  const supported = new Set(['decision', 'reason_code', 'reason_text', 'idempotency_key']);
  const unknown = Object.keys(payload).filter((field) => !supported.has(field));
  if (unknown.length) throw new AdminReviewError(`Unsupported fields: ${unknown.join(', ')}.`);

  const decision = String(payload.decision || '').trim();
  if (!Object.values(REVIEW_ACTIONS).includes(decision)
      || (allowedDecisions && !allowedDecisions.includes(decision))) {
    throw new AdminReviewError('Decision is not allowed for this review case.', 400, 'ADMIN_ACTION_FORBIDDEN');
  }
  const reasonCode = String(payload.reason_code || '').trim();
  if (!ACTION_REASON_CODES[decision]?.includes(reasonCode)) {
    throw new AdminReviewError('reason_code is not valid for this decision.', 400, 'REVIEW_REASON_INVALID');
  }
  if (!isValidUuid(payload.idempotency_key)) {
    throw new AdminReviewError('idempotency_key must be a valid UUID.');
  }
  if (payload.reason_text !== undefined
      && payload.reason_text !== null
      && typeof payload.reason_text !== 'string') {
    throw new AdminReviewError('reason_text must be plain text.');
  }
  const rawReasonText = typeof payload.reason_text === 'string' ? payload.reason_text.trim() : null;
  const reasonText = rawReasonText ? rawReasonText.normalize('NFC').replace(/ {2,}/g, ' ') : null;
  const textRequired = requireText
    || reasonCode === 'OTHER'
    || [
      REVIEW_ACTIONS.RELEASE_WARRANTY_RESERVE,
      REVIEW_ACTIONS.REFUND_WARRANTY_RESERVE,
      REVIEW_ACTIONS.RESOLVE_CANCELLATION_CUSTOMER_FAULT,
      REVIEW_ACTIONS.RESOLVE_CANCELLATION_HANDYMAN_FAULT,
      REVIEW_ACTIONS.RESOLVE_CANCELLATION_NEUTRAL
    ].includes(decision);
  if (textRequired && !reasonText) {
    throw new AdminReviewError('reason_text is required for this decision.', 400, 'REVIEW_REASON_REQUIRED');
  }
  if (reasonText && (reasonText.length > 500
      || CONTROL_CHARACTER_PATTERN.test(reasonText)
      || HTML_TAG_PATTERN.test(reasonText))) {
    throw new AdminReviewError('reason_text contains unsupported content.', 400, 'REVIEW_REASON_INVALID');
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({
    decision,
    reason_code: reasonCode,
    reason_text: reasonText || null
  })).digest('hex');
  return {
    decision,
    reasonCode,
    reasonText: reasonText || null,
    idempotencyKey: payload.idempotency_key,
    fingerprint
  };
};

export { AdminReviewError, isValidUuid, validateDecisionPayload };
