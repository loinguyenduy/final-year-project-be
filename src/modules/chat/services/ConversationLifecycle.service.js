import db from '../../../core/database/connection.js';
import Conversation from '../models/Conversation.model.js';
import {
  CONVERSATION_CLOSED_REASONS,
  CONVERSATION_STATUSES,
  isChatAllowedJobStatus
} from '../constants/chat.constants.js';
import { emitConversationClosedAndEvict } from '../sockets/chat.gateway.js';

const SPECIFIC_LIFECYCLE_REASONS = new Set([
  CONVERSATION_CLOSED_REASONS.CUSTOMER_REOPEN_BIDDING,
  CONVERSATION_CLOSED_REASONS.CUSTOMER_CANCELLED_JOB,
  CONVERSATION_CLOSED_REASONS.HANDYMAN_CANCELLED
]);

const buildClosedPayload = (conversation) => ({
  conversation_id: conversation.id,
  job_id: conversation.job_id,
  acceptance_cycle: conversation.acceptance_cycle,
  reason: conversation.closed_reason,
  closed_at: conversation.closed_at
});

const scheduleClosedNotification = (conversation, transaction) => {
  const notify = () => {
    try {
      emitConversationClosedAndEvict(buildClosedPayload(conversation));
    } catch (error) {
      console.error('[chat] Failed to emit conversation:closed.', {
        conversation_id: conversation.id,
        error: error.message
      });
    }
  };

  if (transaction && typeof transaction.afterCommit === 'function') {
    transaction.afterCommit(notify);
  } else {
    notify();
  }
};

const closeConversationRecord = async (conversation, {
  reason,
  closedByUserId = null,
  transaction = null
}) => {
  if (!conversation || conversation.status === CONVERSATION_STATUSES.CLOSED) {
    return { changed: false, conversation };
  }

  const closedAt = new Date();
  await conversation.update({
    status: CONVERSATION_STATUSES.CLOSED,
    closed_at: closedAt,
    closed_reason: reason,
    closed_by_user_id: closedByUserId
  }, transaction ? { transaction } : undefined);

  scheduleClosedNotification(conversation, transaction);
  return { changed: true, conversation };
};

const deriveReconcileReason = (conversation, job) => {
  if (Number(conversation.acceptance_cycle) !== Number(job.acceptance_cycle)) {
    return CONVERSATION_CLOSED_REASONS.ACCEPTANCE_CYCLE_SUPERSEDED;
  }
  if (isChatAllowedJobStatus(job.current_status)) return null;

  if (job.current_status === 'CANCELLED') {
    return CONVERSATION_CLOSED_REASONS.JOB_CANCELLED;
  }
  if (job.current_status === 'CLOSED') {
    return CONVERSATION_CLOSED_REASONS.JOB_CLOSED;
  }
  return CONVERSATION_CLOSED_REASONS.JOB_RETURNED_TO_BIDDING;
};

const reconcileConversationWithJob = async (conversation, job, { transaction = null } = {}) => {
  if (!conversation || conversation.status === CONVERSATION_STATUSES.CLOSED) {
    return { changed: false, conversation, reason: conversation?.closed_reason || null };
  }

  const reason = deriveReconcileReason(conversation, job);
  if (!reason) return { changed: false, conversation, reason: null };

  const result = await closeConversationRecord(conversation, { reason, transaction });
  if (result.changed) {
    console.warn('[chat] Reconciled stale conversation.', {
      conversation_id: conversation.id,
      job_id: conversation.job_id,
      acceptance_cycle: conversation.acceptance_cycle,
      job_acceptance_cycle: job.acceptance_cycle,
      job_status: job.current_status,
      reason
    });
  }
  return { ...result, reason };
};

const closeConversationForJobCycle = async ({
  jobId,
  acceptanceCycle,
  reason,
  closedByUserId = null
}) => {
  const transaction = await db.transaction();
  try {
    const conversation = await Conversation.findOne({
      where: { job_id: jobId, acceptance_cycle: acceptanceCycle },
      transaction,
      lock: transaction.LOCK.UPDATE
    });

    if (!conversation) {
      await transaction.commit();
      return { changed: false, conversation: null };
    }

    if (conversation.status === CONVERSATION_STATUSES.CLOSED
      && SPECIFIC_LIFECYCLE_REASONS.has(reason)
      && !SPECIFIC_LIFECYCLE_REASONS.has(conversation.closed_reason)) {
      await conversation.update({
        closed_reason: reason,
        closed_by_user_id: closedByUserId
      }, { transaction });
      scheduleClosedNotification(conversation, transaction);
      await transaction.commit();
      return { changed: false, metadataChanged: true, conversation };
    }

    const result = await closeConversationRecord(conversation, {
      reason,
      closedByUserId,
      transaction
    });
    await transaction.commit();
    return result;
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  }
};

const bestEffortCloseConversationForJobCycle = async (options) => {
  try {
    return await closeConversationForJobCycle(options);
  } catch (error) {
    console.error('[chat] Best-effort conversation close failed.', {
      job_id: options.jobId,
      acceptance_cycle: options.acceptanceCycle,
      reason: options.reason,
      error: error.message
    });
    return { changed: false, error };
  }
};

export {
  bestEffortCloseConversationForJobCycle,
  closeConversationForJobCycle,
  closeConversationRecord,
  reconcileConversationWithJob
};
