import { Op } from 'sequelize';
import Job from '../../matchmaking/models/Job.model.js';
import User from '../../identity/models/User.model.js';
import Conversation from '../models/Conversation.model.js';
import { CONVERSATION_STATUSES, isChatAllowedJobStatus } from '../constants/chat.constants.js';
import { chatError } from '../utils/chatError.util.js';
import { isValidUuid } from '../utils/chatValidation.util.js';
import { reconcileConversationWithJob } from './ConversationLifecycle.service.js';

const assertValidUuid = (value, label) => {
  if (!isValidUuid(value)) {
    throw chatError(`Invalid ${label}.`, 400, 'VALIDATION_ERROR');
  }
};

const assertConversationMembership = (conversation, userId) => {
  if (conversation.customer_id !== userId && conversation.handyman_id !== userId) {
    throw chatError('Conversation not found.', 404, 'CONVERSATION_NOT_FOUND');
  }
};

const loadParticipants = async (conversation, { transaction = null } = {}) => {
  const users = await User.findAll({
    where: { id: { [Op.in]: [conversation.customer_id, conversation.handyman_id] } },
    ...(transaction ? { transaction } : {})
  });

  const customer = users.find((user) => user.id === conversation.customer_id);
  const handyman = users.find((user) => user.id === conversation.handyman_id);

  if (!customer || !handyman || customer.role !== 'CUSTOMER' || handyman.role !== 'HANDYMAN') {
    throw chatError(
      'Conversation participant data is inconsistent.',
      409,
      'ACCEPTED_DATA_INCONSISTENT'
    );
  }
  if (!customer.is_active || !handyman.is_active) {
    throw chatError('A conversation participant is inactive.', 409, 'PARTICIPANT_INACTIVE');
  }

  return { customer, handyman };
};

const assertConversationMatchesJob = (conversation, job) => {
  if (job.customer_id !== conversation.customer_id
    || job.selected_handyman_id !== conversation.handyman_id
    || job.selected_bid_id !== conversation.selected_bid_id) {
    throw chatError(
      'Conversation no longer matches the accepted job relationships.',
      409,
      'ACCEPTED_DATA_INCONSISTENT'
    );
  }
};

const validateLockedConversationAccess = async ({
  conversation,
  job,
  userId,
  transaction,
  allowClosed = false
}) => {
  assertConversationMembership(conversation, userId);

  if (conversation.status === CONVERSATION_STATUSES.CLOSED) {
    if (!allowClosed || !['CANCELLED', 'CLOSED'].includes(job.current_status)) {
      throw chatError('Conversation is closed.', 409, 'CONVERSATION_CLOSED', {
        reason: conversation.closed_reason,
        closed_at: conversation.closed_at
      });
    }
    assertConversationMatchesJob(conversation, job);
    const participants = await loadParticipants(conversation, { transaction });
    const currentUser = userId === conversation.customer_id
      ? participants.customer
      : participants.handyman;
    const partner = userId === conversation.customer_id
      ? participants.handyman
      : participants.customer;
    return { currentUser, partner, ...participants, readOnly: true };
  }

  const reconciliation = await reconcileConversationWithJob(conversation, job, { transaction });
  if (reconciliation.changed || !isChatAllowedJobStatus(job.current_status)) {
    if (allowClosed && ['CANCELLED', 'CLOSED'].includes(job.current_status)) {
      assertConversationMatchesJob(conversation, job);
      const participants = await loadParticipants(conversation, { transaction });
      const currentUser = userId === conversation.customer_id
        ? participants.customer
        : participants.handyman;
      const partner = userId === conversation.customer_id
        ? participants.handyman
        : participants.customer;
      return { currentUser, partner, ...participants, readOnly: true };
    }
    return {
      accessError: chatError('Conversation is closed.', 409, 'CONVERSATION_CLOSED', {
        reason: reconciliation.reason,
        closed_at: conversation.closed_at
      })
    };
  }

  assertConversationMatchesJob(conversation, job);
  const participants = await loadParticipants(conversation, { transaction });
  const currentUser = userId === conversation.customer_id
    ? participants.customer
    : participants.handyman;
  const partner = userId === conversation.customer_id
    ? participants.handyman
    : participants.customer;

  return { currentUser, partner, ...participants };
};

const getLockedConversationContext = async ({
  conversationId,
  userId,
  transaction,
  allowClosed = false
}) => {
  assertValidUuid(conversationId, 'conversation id');

  const preliminary = await Conversation.findByPk(conversationId, { transaction });
  if (!preliminary) {
    throw chatError('Conversation not found.', 404, 'CONVERSATION_NOT_FOUND');
  }
  assertConversationMembership(preliminary, userId);

  const job = await Job.findByPk(preliminary.job_id, {
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  if (!job) {
    throw chatError('Job not found.', 404, 'JOB_NOT_FOUND');
  }

  const conversation = await Conversation.findByPk(conversationId, {
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  if (!conversation) {
    throw chatError('Conversation not found.', 404, 'CONVERSATION_NOT_FOUND');
  }

  const access = await validateLockedConversationAccess({
    conversation,
    job,
    userId,
    transaction,
    allowClosed
  });
  if (access.accessError) {
    return { conversation, job, accessError: access.accessError };
  }
  return { conversation, job, ...access };
};

export {
  assertConversationMembership,
  assertValidUuid,
  getLockedConversationContext,
  loadParticipants,
  validateLockedConversationAccess
};
