import db from '../../../core/database/connection.js';
import { CONVERSATION_CLOSED_REASONS } from '../../chat/constants/chat.constants.js';
import Conversation from '../../chat/models/Conversation.model.js';
import { closeConversationRecord } from '../../chat/services/ConversationLifecycle.service.js';
import EContract from '../../fintech/models/EContract.model.js';
import { settleWarrantyReserveInTransaction } from '../../fintech/services/WarrantySettlement.service.js';
import Job from '../../matchmaking/models/Job.model.js';
import JobStatusHistory from '../../matchmaking/models/JobStatusHistory.model.js';
import JobWarranty from '../../matchmaking/models/JobWarranty.model.js';
import WarrantyClaim from '../../matchmaking/models/WarrantyClaim.model.js';
import WarrantyCompletionRequest from '../../matchmaking/models/WarrantyCompletionRequest.model.js';
import {
  DECISION_AUDIT_ACTION,
  REVIEW_ACTIONS,
  REVIEW_CASE_TYPES,
  REVIEW_TARGET_TYPE
} from '../constants/adminReview.constants.js';
import { createAdminAuditLog, findScopedAdminDecision } from './AdminAudit.service.js';
import { emitAdminReviewSignals } from './AdminReviewRealtime.service.js';
import { AdminReviewError, isValidUuid, validateDecisionPayload } from '../utils/adminReviewValidation.util.js';

const CLAIM_DECISIONS = [REVIEW_ACTIONS.APPROVE_REWORK, REVIEW_ACTIONS.REJECT_CLAIM];
const REWORK_DECISIONS = [
  REVIEW_ACTIONS.ALLOW_ANOTHER_REWORK,
  REVIEW_ACTIONS.RELEASE_WARRANTY_RESERVE,
  REVIEW_ACTIONS.REFUND_WARRANTY_RESERVE
];

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
    case_type: audit.after_state?.case_type || null,
    canonical_summary: audit.after_state
  };
};

const throwSettlementError = (result) => {
  if (!result?.error) return;
  throw new AdminReviewError(result.error.EM, result.error.EC, result.error.code, result.error.DT);
};

const claimSnapshot = ({ claim, warranty, job, contract = null, decision = null, settlement = null }) => ({
  case_type: REVIEW_CASE_TYPES.WARRANTY_CLAIM,
  case_id: claim.id,
  job_id: job.id,
  claim_status: claim.status,
  warranty_status: warranty.status,
  job_status: job.current_status,
  contract_status: contract?.status || null,
  decision,
  held_amount: String(warranty.warranty_held_amount),
  released_amount: String(warranty.warranty_released_amount),
  refunded_amount: String(warranty.warranty_refunded_amount || 0),
  resolved_by_admin_id: claim.resolved_by_admin_id,
  resolved_at: claim.resolved_at,
  ...(settlement ? { released_amount: settlement.releasedAmount.toString() } : {})
});

const reworkSnapshot = ({ request, claim, warranty, job, contract = null, decision = null, settlement = null }) => ({
  case_type: REVIEW_CASE_TYPES.WARRANTY_REWORK,
  case_id: request.id,
  request_id: request.id,
  request_sequence: Number(request.request_sequence),
  request_status: request.status,
  job_id: job.id,
  claim_status: claim.status,
  warranty_status: warranty.status,
  job_status: job.current_status,
  contract_status: contract?.status || null,
  decision,
  held_amount: String(warranty.warranty_held_amount),
  released_amount: settlement?.releasedAmount?.toString() || String(warranty.warranty_released_amount),
  refunded_amount: settlement?.refundedAmount?.toString() || String(warranty.warranty_refunded_amount || 0),
  resolved_by_admin_id: claim.resolved_by_admin_id,
  resolved_at: claim.resolved_at
});

const decideWarrantyClaim = async ({ claimId, admin, payload, requestMeta }) => {
  if (!isValidUuid(claimId)) throw new AdminReviewError('claimId must be a valid UUID.');
  const body = validateDecisionPayload(payload, { allowedDecisions: CLAIM_DECISIONS });
  const preliminary = await WarrantyClaim.findByPk(claimId, { attributes: ['id', 'job_id', 'warranty_id'] });
  if (!preliminary) throw new AdminReviewError('Warranty Claim was not found.', 404, 'REVIEW_CASE_NOT_FOUND');

  const transaction = await db.transaction();
  let signal = null;
  try {
    const job = await Job.findByPk(preliminary.job_id, { transaction, lock: transaction.LOCK.UPDATE });
    const warranty = await JobWarranty.findByPk(preliminary.warranty_id, { transaction, lock: transaction.LOCK.UPDATE });
    const claim = await WarrantyClaim.findByPk(claimId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!job || !warranty || !claim) throw new AdminReviewError('Warranty Claim was not found.', 404, 'REVIEW_CASE_NOT_FOUND');

    const auditAction = DECISION_AUDIT_ACTION[body.decision];
    const previousDecision = await findScopedAdminDecision({
      action: auditAction,
      targetType: REVIEW_TARGET_TYPE.WARRANTY_CLAIM,
      targetId: claim.id,
      idempotencyKey: body.idempotencyKey,
      transaction
    });
    const replay = replayOrThrowConflict(previousDecision, body.fingerprint);
    if (replay) {
      await transaction.commit();
      return replay;
    }
    if (claim.status !== 'PENDING_REVIEW'
        || warranty.status !== 'CLAIM_PENDING'
        || warranty.released_at || warranty.refunded_at
        || job.current_status !== 'WARRANTY') {
      throw new AdminReviewError('The Warranty Claim is no longer actionable.', 409, 'SOURCE_STATE_CHANGED');
    }

    const now = new Date();
    const expired = now >= new Date(warranty.ends_at);
    if (body.decision === REVIEW_ACTIONS.REJECT_CLAIM && expired && !body.reasonText) {
      throw new AdminReviewError('reason_text is required because expiry releases the reserve.', 400, 'REVIEW_REASON_REQUIRED');
    }
    const beforeState = claimSnapshot({ claim, warranty, job });
    let contract = null;
    let settlement = null;
    if (body.decision === REVIEW_ACTIONS.APPROVE_REWORK) {
      await claim.update({
        status: 'APPROVED_REWORK_REQUIRED',
        reviewed_by_admin_id: admin.id,
        reviewed_at: now,
        admin_note: body.reasonText
      }, { transaction });
      await warranty.update({ status: 'REWORK_REQUIRED' }, { transaction });
    } else if (!expired) {
      await claim.update({
        status: 'REJECTED',
        reviewed_by_admin_id: admin.id,
        reviewed_at: now,
        resolved_by_admin_id: admin.id,
        resolved_at: now,
        admin_note: body.reasonText
      }, { transaction });
      await warranty.update({ status: 'ACTIVE' }, { transaction });
    } else {
      contract = await EContract.findOne({
        where: { id: warranty.contract_id, job_id: job.id, acceptance_cycle: job.acceptance_cycle },
        transaction,
        lock: transaction.LOCK.UPDATE
      });
      if (!contract || contract.status !== 'ACTIVE') {
        throw new AdminReviewError('Contract state is inconsistent.', 409, 'FINANCIAL_DATA_INCONSISTENT');
      }
      settlement = await settleWarrantyReserveInTransaction({ job, warranty, transaction, beneficiary: 'HANDYMAN' });
      throwSettlementError(settlement);
      await claim.update({
        status: 'REJECTED',
        reviewed_by_admin_id: admin.id,
        reviewed_at: now,
        resolved_by_admin_id: admin.id,
        resolved_at: now,
        admin_note: body.reasonText
      }, { transaction });
      await warranty.update({
        status: 'COMPLETED',
        warranty_released_amount: settlement.releasedAmount.toString(),
        released_at: now,
        release_transaction_id: settlement.releaseTransaction.id
      }, { transaction });
      await job.update({ current_status: 'CLOSED' }, { transaction });
      await contract.update({ status: 'COMPLETED' }, { transaction });
      await JobStatusHistory.create({
        job_id: job.id,
        changed_by_user_id: admin.id,
        old_status: 'WARRANTY',
        new_status: 'CLOSED',
        reason: `ADMIN_REJECTED_EXPIRED_WARRANTY_CLAIM:${claim.id}`
      }, { transaction });
      const conversation = await Conversation.findOne({
        where: { job_id: job.id, acceptance_cycle: job.acceptance_cycle },
        transaction,
        lock: transaction.LOCK.UPDATE
      });
      if (conversation) {
        await closeConversationRecord(conversation, {
          reason: CONVERSATION_CLOSED_REASONS.JOB_CLOSED,
          closedByUserId: admin.id,
          transaction
        });
      }
    }

    const afterState = claimSnapshot({
      claim,
      warranty,
      job,
      contract,
      decision: body.decision,
      settlement
    });
    const audit = await createAdminAuditLog({
      adminId: admin.id,
      action: auditAction,
      targetType: REVIEW_TARGET_TYPE.WARRANTY_CLAIM,
      targetId: claim.id,
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
    signal = { caseType: REVIEW_CASE_TYPES.WARRANTY_CLAIM, caseId: claim.id, jobId: job.id, userIds: [job.customer_id, job.selected_handyman_id] };
    emitAdminReviewSignals(signal);
    return {
      replayed: false,
      audit_id: audit.id,
      decision: body.decision,
      case_id: claim.id,
      case_type: REVIEW_CASE_TYPES.WARRANTY_CLAIM,
      canonical_summary: afterState,
      participant_message_code: expired && body.decision === REVIEW_ACTIONS.REJECT_CLAIM
        ? 'CLAIM_REJECTED_WARRANTY_EXPIRED_RELEASED'
        : null
    };
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  }
};

const decideWarrantyRework = async ({ requestId, admin, payload, requestMeta }) => {
  if (!isValidUuid(requestId)) throw new AdminReviewError('requestId must be a valid UUID.');
  const body = validateDecisionPayload(payload, { allowedDecisions: REWORK_DECISIONS });
  const preliminary = await WarrantyCompletionRequest.findByPk(requestId, {
    attributes: ['id', 'job_id', 'warranty_id', 'claim_id']
  });
  if (!preliminary) throw new AdminReviewError('Warranty Rework case was not found.', 404, 'REVIEW_CASE_NOT_FOUND');

  const transaction = await db.transaction();
  try {
    const job = await Job.findByPk(preliminary.job_id, { transaction, lock: transaction.LOCK.UPDATE });
    const warranty = await JobWarranty.findByPk(preliminary.warranty_id, { transaction, lock: transaction.LOCK.UPDATE });
    const claim = await WarrantyClaim.findByPk(preliminary.claim_id, { transaction, lock: transaction.LOCK.UPDATE });
    const requests = await WarrantyCompletionRequest.findAll({
      where: { warranty_id: preliminary.warranty_id },
      order: [['request_sequence', 'ASC']],
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    const request = requests.find((entry) => entry.id === requestId);
    if (!job || !warranty || !claim || !request) {
      throw new AdminReviewError('Warranty Rework case was not found.', 404, 'REVIEW_CASE_NOT_FOUND');
    }

    const auditAction = DECISION_AUDIT_ACTION[body.decision];
    const previousDecision = await findScopedAdminDecision({
      action: auditAction,
      targetType: REVIEW_TARGET_TYPE.WARRANTY_REWORK,
      targetId: request.id,
      idempotencyKey: body.idempotencyKey,
      transaction
    });
    const replay = replayOrThrowConflict(previousDecision, body.fingerprint);
    if (replay) {
      await transaction.commit();
      return replay;
    }
    const latestRequest = requests.at(-1);
    if (request.id !== latestRequest?.id
        || request.status !== 'REJECTED'
        || warranty.status !== 'REVIEW_REQUIRED'
        || warranty.released_at || warranty.refunded_at
        || claim.status !== 'REVIEW_REQUIRED'
        || job.current_status !== 'WARRANTY') {
      throw new AdminReviewError('The Warranty Rework case is no longer actionable.', 409, 'SOURCE_STATE_CHANGED');
    }
    if (body.decision === REVIEW_ACTIONS.ALLOW_ANOTHER_REWORK && Number(request.request_sequence) >= 2) {
      throw new AdminReviewError('The maximum of two rework cycles has been reached.', 409, 'REWORK_CYCLE_LIMIT_REACHED');
    }

    const beforeState = reworkSnapshot({ request, claim, warranty, job });
    const now = new Date();
    let contract = null;
    let settlement = null;
    if (body.decision === REVIEW_ACTIONS.ALLOW_ANOTHER_REWORK) {
      await claim.update({ status: 'APPROVED_REWORK_REQUIRED', admin_note: body.reasonText }, { transaction });
      await warranty.update({ status: 'REWORK_REQUIRED' }, { transaction });
    } else {
      contract = await EContract.findOne({
        where: { id: warranty.contract_id, job_id: job.id, acceptance_cycle: job.acceptance_cycle },
        transaction,
        lock: transaction.LOCK.UPDATE
      });
      if (!contract || contract.status !== 'ACTIVE') {
        throw new AdminReviewError('Contract state is inconsistent.', 409, 'FINANCIAL_DATA_INCONSISTENT');
      }
      const beneficiary = body.decision === REVIEW_ACTIONS.RELEASE_WARRANTY_RESERVE ? 'HANDYMAN' : 'CUSTOMER';
      settlement = await settleWarrantyReserveInTransaction({
        job,
        warranty,
        transaction,
        beneficiary,
        warrantyCompletionRequestId: request.id
      });
      throwSettlementError(settlement);
      await claim.update({
        status: 'RESOLVED',
        resolved_by_admin_id: claim.resolved_by_admin_id || admin.id,
        resolved_at: claim.resolved_at || now,
        admin_note: body.reasonText
      }, { transaction });
      await warranty.update({
        status: 'COMPLETED',
        ...(beneficiary === 'HANDYMAN' ? {
          warranty_released_amount: settlement.releasedAmount.toString(),
          released_at: now,
          release_transaction_id: settlement.releaseTransaction.id
        } : {
          warranty_refunded_amount: settlement.refundedAmount.toString(),
          refunded_at: now,
          refund_transaction_id: settlement.refundTransaction.id
        })
      }, { transaction });
      await job.update({ current_status: 'CLOSED' }, { transaction });
      await contract.update({ status: 'COMPLETED' }, { transaction });
      await JobStatusHistory.create({
        job_id: job.id,
        changed_by_user_id: admin.id,
        old_status: 'WARRANTY',
        new_status: 'CLOSED',
        reason: `${body.decision}:${request.id}`
      }, { transaction });
      const conversation = await Conversation.findOne({
        where: { job_id: job.id, acceptance_cycle: job.acceptance_cycle },
        transaction,
        lock: transaction.LOCK.UPDATE
      });
      if (conversation) {
        await closeConversationRecord(conversation, {
          reason: CONVERSATION_CLOSED_REASONS.JOB_CLOSED,
          closedByUserId: admin.id,
          transaction
        });
      }
    }

    const afterState = reworkSnapshot({ request, claim, warranty, job, contract, decision: body.decision, settlement });
    const audit = await createAdminAuditLog({
      adminId: admin.id,
      action: auditAction,
      targetType: REVIEW_TARGET_TYPE.WARRANTY_REWORK,
      targetId: request.id,
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
    emitAdminReviewSignals({
      caseType: REVIEW_CASE_TYPES.WARRANTY_REWORK,
      caseId: request.id,
      jobId: job.id,
      userIds: [job.customer_id, job.selected_handyman_id]
    });
    return {
      replayed: false,
      audit_id: audit.id,
      decision: body.decision,
      case_id: request.id,
      case_type: REVIEW_CASE_TYPES.WARRANTY_REWORK,
      canonical_summary: afterState
    };
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  }
};

export { decideWarrantyClaim, decideWarrantyRework };
