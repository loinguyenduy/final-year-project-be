import { Op } from 'sequelize';
import db from '../../../core/database/connection.js';
import Job from '../../matchmaking/models/Job.model.js';
import User from '../../identity/models/User.model.js';
import { validateAcceptedJobInvariants } from '../../matchmaking/services/AcceptedJob.service.js';
import Conversation from '../models/Conversation.model.js';
import Message from '../models/Message.model.js';
import {
  CONVERSATION_CLOSED_REASONS,
  CONVERSATION_STATUSES,
  isChatAllowedJobStatus
} from '../constants/chat.constants.js';
import { chatError } from '../utils/chatError.util.js';
import {
  assertConversationMembership,
  assertValidUuid,
  getLockedConversationContext
} from './ChatAccess.service.js';
import {
  closeConversationRecord,
  reconcileConversationWithJob
} from './ConversationLifecycle.service.js';

const getReadFields = (conversation, userId) => {
  const isCustomer = conversation.customer_id === userId;
  return {
    currentLastReadMessageId: isCustomer
      ? conversation.customer_last_read_message_id
      : conversation.handyman_last_read_message_id,
    currentLastReadAt: isCustomer
      ? conversation.customer_last_read_at
      : conversation.handyman_last_read_at,
    partnerLastReadMessageId: isCustomer
      ? conversation.handyman_last_read_message_id
      : conversation.customer_last_read_message_id,
    partnerLastReadAt: isCustomer
      ? conversation.handyman_last_read_at
      : conversation.customer_last_read_at
  };
};

const buildAfterCursorWhere = async (conversationId, messageId, transaction) => {
  if (!messageId) return {};
  const cursorMessage = await Message.findOne({
    where: { id: messageId, conversation_id: conversationId },
    transaction
  });
  if (!cursorMessage) {
    throw chatError('Read cursor data is inconsistent.', 409, 'READ_STATE_INCONSISTENT');
  }
  return {
    [Op.or]: [
      { createdAt: { [Op.gt]: cursorMessage.createdAt } },
      { createdAt: cursorMessage.createdAt, id: { [Op.gt]: cursorMessage.id } }
    ]
  };
};

const buildConversationDto = async ({ conversation, partner, userId, transaction }) => {
  const readFields = getReadFields(conversation, userId);
  const afterCursor = await buildAfterCursorWhere(
    conversation.id,
    readFields.currentLastReadMessageId,
    transaction
  );
  const unreadCount = await Message.count({
    where: {
      conversation_id: conversation.id,
      sender_id: { [Op.ne]: userId },
      ...afterCursor
    },
    transaction
  });

  return {
    id: conversation.id,
    job_id: conversation.job_id,
    acceptance_cycle: conversation.acceptance_cycle,
    selected_bid_id: conversation.selected_bid_id,
    status: conversation.status,
    created_at: conversation.createdAt,
    last_message_at: conversation.last_message_at,
    current_user_last_read_message_id: readFields.currentLastReadMessageId,
    current_user_last_read_at: readFields.currentLastReadAt,
    partner_last_read_message_id: readFields.partnerLastReadMessageId,
    partner_last_read_at: readFields.partnerLastReadAt,
    unread_count: unreadCount,
    partner: {
      id: partner.id,
      full_name: partner.full_name,
      avatar_url: partner.avatar_url,
      role: partner.role
    },
    allowed_actions: ['JOIN', 'SEND', 'READ', 'HISTORY']
  };
};

const loadCurrentJobParticipants = async (job, userId, transaction) => {
  if (job.customer_id !== userId && job.selected_handyman_id !== userId) {
    throw chatError('Conversation not found.', 404, 'CONVERSATION_NOT_FOUND');
  }
  if (!job.customer_id || !job.selected_handyman_id || !job.selected_bid_id) {
    throw chatError('Accepted job data is incomplete.', 409, 'ACCEPTED_DATA_INCONSISTENT');
  }

  const users = await User.findAll({
    where: { id: { [Op.in]: [job.customer_id, job.selected_handyman_id] } },
    transaction
  });
  const customer = users.find((user) => user.id === job.customer_id);
  const handyman = users.find((user) => user.id === job.selected_handyman_id);

  if (!customer || !handyman || customer.role !== 'CUSTOMER' || handyman.role !== 'HANDYMAN') {
    throw chatError('Accepted participant data is inconsistent.', 409, 'ACCEPTED_DATA_INCONSISTENT');
  }
  if (!customer.is_active || !handyman.is_active) {
    throw chatError('A conversation participant is inactive.', 409, 'PARTICIPANT_INACTIVE');
  }

  return {
    customer,
    handyman,
    partner: userId === customer.id ? handyman : customer
  };
};

const createOrGetConversationService = async (jobId, userId) => {
  assertValidUuid(jobId, 'job id');
  let response;
  let deferredError = null;

  await db.transaction(async (transaction) => {
    const job = await Job.findByPk(jobId, {
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!job) throw chatError('Job not found.', 404, 'JOB_NOT_FOUND');
    if (!isChatAllowedJobStatus(job.current_status)) {
      const cycleConversation = await Conversation.findOne({
        where: { job_id: job.id, acceptance_cycle: job.acceptance_cycle },
        transaction,
        lock: transaction.LOCK.UPDATE
      });
      if (cycleConversation) {
        assertConversationMembership(cycleConversation, userId);
        if (cycleConversation.status === CONVERSATION_STATUSES.ACTIVE) {
          const reconciliation = await reconcileConversationWithJob(
            cycleConversation,
            job,
            { transaction }
          );
          deferredError = chatError('Conversation is closed.', 409, 'CONVERSATION_CLOSED', {
            reason: reconciliation.reason,
            closed_at: cycleConversation.closed_at
          });
          return;
        }
        throw chatError('Conversation is closed.', 409, 'CONVERSATION_CLOSED', {
          reason: cycleConversation.closed_reason,
          closed_at: cycleConversation.closed_at
        });
      }
      if (job.customer_id !== userId && job.selected_handyman_id !== userId) {
        throw chatError('Conversation not found.', 404, 'CONVERSATION_NOT_FOUND');
      }
      deferredError = chatError(
        'Chat is not allowed for the current job status.',
        409,
        'CHAT_NOT_ALLOWED_FOR_JOB_STATUS',
        { current_status: job.current_status }
      );
      return;
    }
    if (Number(job.acceptance_cycle) <= 0) {
      throw chatError('Job acceptance cycle is inconsistent.', 409, 'ACCEPTANCE_CYCLE_INCONSISTENT');
    }

    const activeConversations = await Conversation.findAll({
      where: { job_id: job.id, status: CONVERSATION_STATUSES.ACTIVE },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    let reconciledStale = false;
    for (const active of activeConversations) {
      if (Number(active.acceptance_cycle) !== Number(job.acceptance_cycle)) {
        const closed = await closeConversationRecord(active, {
          reason: CONVERSATION_CLOSED_REASONS.ACCEPTANCE_CYCLE_SUPERSEDED,
          transaction
        });
        reconciledStale ||= closed.changed;
      }
    }

    let participants;
    try {
      participants = await loadCurrentJobParticipants(job, userId, transaction);
    } catch (error) {
      if (reconciledStale) {
        deferredError = error;
        return;
      }
      throw error;
    }
    const invariant = await validateAcceptedJobInvariants(job, { transaction });
    if (invariant.error) {
      const error = chatError(
        invariant.error.EM,
        invariant.error.EC,
        invariant.error.code || 'ACCEPTED_DATA_INCONSISTENT',
        invariant.error.DT
      );
      if (reconciledStale) {
        deferredError = error;
        return;
      }
      throw error;
    }

    let conversation = await Conversation.findOne({
      where: { job_id: job.id, acceptance_cycle: job.acceptance_cycle },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (conversation?.status === CONVERSATION_STATUSES.CLOSED) {
      const error = chatError('Conversation is closed.', 409, 'CONVERSATION_CLOSED', {
        reason: conversation.closed_reason,
        closed_at: conversation.closed_at
      });
      if (reconciledStale) {
        deferredError = error;
        return;
      }
      throw error;
    }

    let created = false;
    if (!conversation) {
      conversation = await Conversation.create({
        job_id: job.id,
        acceptance_cycle: job.acceptance_cycle,
        customer_id: job.customer_id,
        handyman_id: job.selected_handyman_id,
        selected_bid_id: job.selected_bid_id,
        status: CONVERSATION_STATUSES.ACTIVE
      }, { transaction });
      created = true;
    } else if (conversation.customer_id !== job.customer_id
      || conversation.handyman_id !== job.selected_handyman_id
      || conversation.selected_bid_id !== job.selected_bid_id) {
      const error = chatError(
        'Conversation does not match the current acceptance cycle.',
        409,
        'ACCEPTED_DATA_INCONSISTENT'
      );
      if (reconciledStale) {
        deferredError = error;
        return;
      }
      throw error;
    }

    response = {
      created,
      conversation: await buildConversationDto({
        conversation,
        partner: participants.partner,
        userId,
        transaction
      })
    };
  });

  if (deferredError) throw deferredError;

  return response;
};

const getConversationByJobService = async (jobId, userId) => {
  assertValidUuid(jobId, 'job id');
  let dto;
  let deferredError = null;

  await db.transaction(async (transaction) => {
    const job = await Job.findByPk(jobId, {
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!job) throw chatError('Job not found.', 404, 'JOB_NOT_FOUND');

    const activeConversations = await Conversation.findAll({
      where: { job_id: job.id, status: CONVERSATION_STATUSES.ACTIVE },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    let reconciledStale = false;
    for (const active of activeConversations) {
      const reconciliation = await reconcileConversationWithJob(active, job, { transaction });
      reconciledStale ||= reconciliation.changed;
    }

    let currentParticipants = null;
    if (isChatAllowedJobStatus(job.current_status)) {
      try {
        currentParticipants = await loadCurrentJobParticipants(job, userId, transaction);
      } catch (error) {
        if (reconciledStale) {
          deferredError = error;
          return;
        }
        throw error;
      }
    }

    const conversation = await Conversation.findOne({
      where: { job_id: job.id, acceptance_cycle: job.acceptance_cycle },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!conversation) {
      const error = chatError('Conversation not found.', 404, 'CONVERSATION_NOT_FOUND');
      if (reconciledStale) {
        deferredError = error;
        return;
      }
      throw error;
    }
    assertConversationMembership(conversation, userId);
    const context = await getLockedConversationContext({
      conversationId: conversation.id,
      userId,
      transaction,
      allowClosed: true
    });
    if (context.accessError) {
      deferredError = context.accessError;
      return;
    }
    dto = await buildConversationDto({
      conversation: context.conversation,
      partner: context.partner || currentParticipants?.partner,
      userId,
      transaction
    });
  });

  if (deferredError) throw deferredError;

  return dto;
};

const getConversationForJoinService = async (conversationId, userId) => {
  let dto;
  let deferredError = null;
  await db.transaction(async (transaction) => {
    const context = await getLockedConversationContext({ conversationId, userId, transaction });
    if (context.accessError) {
      deferredError = context.accessError;
      return;
    }
    dto = await buildConversationDto({
      conversation: context.conversation,
      partner: context.partner,
      userId,
      transaction
    });
  });
  if (deferredError) throw deferredError;
  return dto;
};

export {
  buildConversationDto,
  createOrGetConversationService,
  getConversationByJobService,
  getConversationForJoinService,
  getReadFields
};
