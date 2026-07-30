import db from '../../../core/database/connection.js';
import Job from '../../matchmaking/models/Job.model.js';
import JobCancellation from '../../matchmaking/models/JobCancellation.model.js';
import {
  emitCancellationEvent,
  resolveCancellationInTransaction,
  validateLateLifecycleInvariants
} from '../../matchmaking/services/LifecycleCancellation.service.js';
import { JOB_LIFECYCLE_EVENTS } from '../../matchmaking/sockets/JobLifecycle.gateway.js';
import { calculateCancellationDistribution, parseVndInteger } from '../../matchmaking/utils/cancellationPolicy.util.js';
import {
  DECISION_AUDIT_ACTION,
  REVIEW_ACTIONS,
  REVIEW_CASE_TYPES,
  REVIEW_TARGET_TYPE
} from '../constants/adminReview.constants.js';
import { createAdminAuditLog, findScopedAdminDecision } from './AdminAudit.service.js';
import { emitAdminReviewSignals } from './AdminReviewRealtime.service.js';
import { AdminReviewError, isValidUuid, validateDecisionPayload } from '../utils/adminReviewValidation.util.js';

const CANCELLATION_DECISIONS = [
  REVIEW_ACTIONS.RESOLVE_CANCELLATION_CUSTOMER_FAULT,
  REVIEW_ACTIONS.RESOLVE_CANCELLATION_HANDYMAN_FAULT,
  REVIEW_ACTIONS.RESOLVE_CANCELLATION_NEUTRAL
];
const CLASSIFICATION_BY_DECISION = Object.freeze({
  [REVIEW_ACTIONS.RESOLVE_CANCELLATION_CUSTOMER_FAULT]: 'CUSTOMER_FAULT',
  [REVIEW_ACTIONS.RESOLVE_CANCELLATION_HANDYMAN_FAULT]: 'HANDYMAN_FAULT',
  [REVIEW_ACTIONS.RESOLVE_CANCELLATION_NEUTRAL]: 'NEUTRAL'
});
const APPROVED_SOURCE_PHASES = Object.freeze(['EN_ROUTE', 'ARRIVED', 'QUOTE_PENDING', 'PAYMENT_PENDING']);

const replayOrThrowConflict = (audit, fingerprint) => {
  if (!audit) return null;
  if (audit.request_fingerprint !== fingerprint) {
    throw new AdminReviewError('The idempotency key was already used with a different decision.', 409, 'IDEMPOTENCY_CONFLICT');
  }
  return {
    replayed: true,
    audit_id: audit.id,
    decision: audit.after_state?.decision || null,
    case_id: audit.target_id,
    case_type: REVIEW_CASE_TYPES.CANCELLATION,
    canonical_summary: audit.after_state
  };
};

const cancellationSnapshot = ({ cancellation, job, decision = null }) => ({
  case_type: REVIEW_CASE_TYPES.CANCELLATION,
  case_id: cancellation.id,
  job_id: job.id,
  cancellation_status: cancellation.status,
  job_status: job.current_status,
  classification: cancellation.classification,
  decision,
  held_amount: cancellation.deposit_amount == null ? null : String(cancellation.deposit_amount),
  customer_refund_amount: cancellation.refund_amount == null ? null : String(cancellation.refund_amount),
  handyman_compensation_amount: cancellation.handyman_compensation_amount == null
    ? null : String(cancellation.handyman_compensation_amount),
  platform_amount: cancellation.platform_amount == null ? null : String(cancellation.platform_amount),
  resolved_by_admin_id: cancellation.resolved_by_user_id,
  resolved_at: cancellation.resolved_at
});

const decideCancellation = async ({ cancellationId, admin, payload, requestMeta }) => {
  if (!isValidUuid(cancellationId)) throw new AdminReviewError('cancellationId must be a valid UUID.');
  const body = validateDecisionPayload(payload, { allowedDecisions: CANCELLATION_DECISIONS, requireText: true });
  const preliminary = await JobCancellation.findByPk(cancellationId, { attributes: ['id', 'job_id'] });
  if (!preliminary) throw new AdminReviewError('Cancellation Review case was not found.', 404, 'REVIEW_CASE_NOT_FOUND');

  const transaction = await db.transaction();
  try {
    const job = await Job.findByPk(preliminary.job_id, { transaction, lock: transaction.LOCK.UPDATE });
    const cancellation = await JobCancellation.findByPk(cancellationId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!job || !cancellation || cancellation.status === null) {
      throw new AdminReviewError('Cancellation Review case was not found.', 404, 'REVIEW_CASE_NOT_FOUND');
    }

    const auditAction = DECISION_AUDIT_ACTION[body.decision];
    const previousDecision = await findScopedAdminDecision({
      action: auditAction,
      targetType: REVIEW_TARGET_TYPE.CANCELLATION,
      targetId: cancellation.id,
      idempotencyKey: body.idempotencyKey,
      transaction
    });
    const replay = replayOrThrowConflict(previousDecision, body.fingerprint);
    if (replay) {
      await transaction.commit();
      return replay;
    }
    if (job.current_status !== 'CANCELLATION_REVIEW'
        || cancellation.status !== 'REVIEW_REQUIRED'
        || !APPROVED_SOURCE_PHASES.includes(cancellation.status_when_cancelled)) {
      throw new AdminReviewError('The Cancellation Review case is no longer actionable.', 409, 'SOURCE_STATE_CHANGED');
    }
    const invariant = await validateLateLifecycleInvariants(job, transaction);
    if (invariant.error) {
      throw new AdminReviewError(invariant.error.EM, invariant.error.EC, invariant.error.code, invariant.error.DT);
    }
    const storedDeposit = parseVndInteger(cancellation.deposit_amount);
    if (!storedDeposit.valid || storedDeposit.amount !== invariant.depositAmount) {
      throw new AdminReviewError('Cancellation deposit data is inconsistent.', 409, 'FINANCIAL_DATA_INCONSISTENT');
    }
    const classification = CLASSIFICATION_BY_DECISION[body.decision];
    const distribution = calculateCancellationDistribution({
      depositAmount: invariant.depositAmount,
      phase: cancellation.status_when_cancelled,
      classification
    });
    if (!distribution.valid || distribution.platformAmount !== 0n) {
      throw new AdminReviewError('Cancellation policy is not configured.', 409, 'CANCELLATION_POLICY_NOT_CONFIGURED');
    }

    const beforeState = cancellationSnapshot({ cancellation, job });
    await cancellation.update({ classification, resolution_mode: 'ADMIN_REVIEW' }, { transaction });
    const resolved = await resolveCancellationInTransaction({
      job,
      cancellation,
      invariant,
      distribution,
      resolvedByUserId: admin.id,
      resolutionNote: body.reasonText,
      transaction
    });
    if (resolved.error) {
      throw new AdminReviewError(resolved.error.EM, resolved.error.EC, resolved.error.code, resolved.error.DT);
    }
    const afterState = cancellationSnapshot({ cancellation, job, decision: body.decision });
    const audit = await createAdminAuditLog({
      adminId: admin.id,
      action: auditAction,
      targetType: REVIEW_TARGET_TYPE.CANCELLATION,
      targetId: cancellation.id,
      reasonCode: body.reasonCode,
      reasonText: body.reasonText,
      beforeState,
      afterState,
      correlationId: requestMeta.correlationId,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      idempotencyKey: body.idempotencyKey,
      requestFingerprint: body.fingerprint,
      transaction
    });
    await transaction.commit();
    emitCancellationEvent({ event: JOB_LIFECYCLE_EVENTS.CANCELLED, job, cancellation });
    emitAdminReviewSignals({
      caseType: REVIEW_CASE_TYPES.CANCELLATION,
      caseId: cancellation.id,
      userIds: [job.customer_id, job.selected_handyman_id]
    });
    return {
      replayed: false,
      audit_id: audit.id,
      decision: body.decision,
      case_id: cancellation.id,
      case_type: REVIEW_CASE_TYPES.CANCELLATION,
      canonical_summary: afterState
    };
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  }
};

export { decideCancellation };
