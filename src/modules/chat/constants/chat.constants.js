const CHAT_ALLOWED_JOB_STATUSES = Object.freeze([
  'ACCEPTED',
  'EN_ROUTE',
  'ARRIVED',
  'IN_PROGRESS',
  'WARRANTY'
]);

const CONVERSATION_STATUSES = Object.freeze({
  ACTIVE: 'ACTIVE',
  CLOSED: 'CLOSED'
});

const CONVERSATION_CLOSED_REASONS = Object.freeze({
  CUSTOMER_REOPEN_BIDDING: 'CUSTOMER_REOPEN_BIDDING',
  CUSTOMER_CANCELLED_JOB: 'CUSTOMER_CANCELLED_JOB',
  HANDYMAN_CANCELLED: 'HANDYMAN_CANCELLED',
  JOB_CANCELLED: 'JOB_CANCELLED',
  JOB_CLOSED: 'JOB_CLOSED',
  JOB_RETURNED_TO_BIDDING: 'JOB_RETURNED_TO_BIDDING',
  ACCEPTANCE_CYCLE_SUPERSEDED: 'ACCEPTANCE_CYCLE_SUPERSEDED'
});

const CHAT_EVENTS = Object.freeze({
  JOIN: 'conversation:join',
  LEAVE: 'conversation:leave',
  SEND_MESSAGE: 'message:send',
  READ: 'conversation:read',
  NEW_MESSAGE: 'message:new',
  READ_UPDATED: 'conversation:read_updated',
  CLOSED: 'conversation:closed',
  ERROR: 'chat:error'
});

const CHAT_ROOM_PREFIX = 'conversation:';
const MESSAGE_MAX_LENGTH = 2000;
const MESSAGE_PAGE_DEFAULT = 30;
const MESSAGE_PAGE_MAX = 50;

const isChatAllowedJobStatus = (status) => CHAT_ALLOWED_JOB_STATUSES.includes(status);
const getConversationRoom = (conversationId) => `${CHAT_ROOM_PREFIX}${conversationId}`;

export {
  CHAT_ALLOWED_JOB_STATUSES,
  CHAT_EVENTS,
  CONVERSATION_CLOSED_REASONS,
  CONVERSATION_STATUSES,
  MESSAGE_MAX_LENGTH,
  MESSAGE_PAGE_DEFAULT,
  MESSAGE_PAGE_MAX,
  getConversationRoom,
  isChatAllowedJobStatus
};
