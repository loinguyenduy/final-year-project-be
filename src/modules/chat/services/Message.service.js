import { Op } from 'sequelize';
import db from '../../../core/database/connection.js';
import Message from '../models/Message.model.js';
import { MESSAGE_PAGE_DEFAULT, MESSAGE_PAGE_MAX } from '../constants/chat.constants.js';
import { chatError } from '../utils/chatError.util.js';
import { decodeMessageCursor, encodeMessageCursor } from '../utils/chatCursor.util.js';
import { isValidUuid } from '../utils/chatValidation.util.js';
import { normalizeMessageContent } from '../utils/messageNormalizer.util.js';
import { compareMessagePosition } from '../utils/messageOrder.util.js';
import { getLockedConversationContext } from './ChatAccess.service.js';
import { getReadFields } from './Conversation.service.js';

const loadMessageInConversation = async (messageId, conversationId, transaction) => {
  if (!messageId) return null;
  return Message.findOne({
    where: { id: messageId, conversation_id: conversationId },
    transaction
  });
};

const buildMessageDto = ({
  message,
  requesterUserId,
  conversation,
  partnerReadCursorMessage = null
}) => {
  const isOwnMessage = message.sender_id === requesterUserId;
  const readFields = getReadFields(conversation, requesterUserId);
  const isSeen = Boolean(
    isOwnMessage
    && partnerReadCursorMessage
    && compareMessagePosition(message, partnerReadCursorMessage) <= 0
  );

  return {
    id: message.id,
    conversation_id: message.conversation_id,
    sender_id: message.sender_id,
    client_message_id: message.client_message_id,
    message_type: message.message_type,
    content: message.content,
    sent_at: message.createdAt,
    is_seen: isSeen,
    seen_at: isSeen ? readFields.partnerLastReadAt : null
  };
};

const sendMessageService = async ({
  conversationId,
  senderId,
  clientMessageId,
  content
}) => {
  if (!isValidUuid(conversationId)) {
    throw chatError('Invalid conversation id.', 400, 'VALIDATION_ERROR');
  }
  if (!isValidUuid(clientMessageId)) {
    throw chatError('Invalid client_message_id.', 400, 'INVALID_CLIENT_MESSAGE_ID');
  }
  const normalizedContent = normalizeMessageContent(content);

  let result;
  let deferredError = null;
  await db.transaction(async (transaction) => {
    const context = await getLockedConversationContext({
      conversationId,
      userId: senderId,
      transaction
    });
    if (context.accessError) {
      deferredError = context.accessError;
      return;
    }

    const existing = await Message.findOne({
      where: {
        conversation_id: conversationId,
        sender_id: senderId,
        client_message_id: clientMessageId
      },
      transaction
    });

    const readFields = getReadFields(context.conversation, senderId);
    const partnerReadCursorMessage = await loadMessageInConversation(
      readFields.partnerLastReadMessageId,
      conversationId,
      transaction
    );

    if (existing) {
      if (existing.content !== normalizedContent) {
        throw chatError(
          'client_message_id was already used with different content.',
          409,
          'CLIENT_MESSAGE_ID_CONFLICT'
        );
      }

      result = {
        duplicate: true,
        message: buildMessageDto({
          message: existing,
          requesterUserId: senderId,
          conversation: context.conversation,
          partnerReadCursorMessage
        })
      };
      return;
    }

    const message = await Message.create({
      conversation_id: conversationId,
      sender_id: senderId,
      client_message_id: clientMessageId,
      content: normalizedContent,
      message_type: 'TEXT'
    }, { transaction });

    await context.conversation.update(
      { last_message_at: message.createdAt },
      { transaction }
    );

    result = {
      duplicate: false,
      message: buildMessageDto({
        message,
        requesterUserId: senderId,
        conversation: context.conversation,
        partnerReadCursorMessage
      })
    };
  });

  if (deferredError) throw deferredError;
  return result;
};

const parsePageLimit = (value) => {
  if (value === undefined || value === null || value === '') return MESSAGE_PAGE_DEFAULT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MESSAGE_PAGE_MAX) {
    throw chatError(
      `limit must be an integer between 1 and ${MESSAGE_PAGE_MAX}.`,
      400,
      'VALIDATION_ERROR'
    );
  }
  return limit;
};

const getMessageHistoryService = async ({
  conversationId,
  userId,
  cursor,
  limit: rawLimit
}) => {
  if (!isValidUuid(conversationId)) {
    throw chatError('Invalid conversation id.', 400, 'VALIDATION_ERROR');
  }
  const limit = parsePageLimit(rawLimit);
  let response;
  let deferredError = null;

  await db.transaction(async (transaction) => {
    const context = await getLockedConversationContext({
      conversationId,
      userId,
      transaction,
      allowClosed: true
    });
    if (context.accessError) {
      deferredError = context.accessError;
      return;
    }

    let beforeWhere = {};
    if (cursor) {
      const decoded = decodeMessageCursor(cursor, conversationId);
      const cursorMessage = await loadMessageInConversation(decoded.id, conversationId, transaction);
      if (!cursorMessage
        || new Date(cursorMessage.createdAt).getTime() !== decoded.createdAt.getTime()) {
        throw chatError('Invalid message cursor.', 400, 'INVALID_CURSOR');
      }
      beforeWhere = {
        [Op.or]: [
          { createdAt: { [Op.lt]: decoded.createdAt } },
          { createdAt: decoded.createdAt, id: { [Op.lt]: decoded.id } }
        ]
      };
    }

    const records = await Message.findAll({
      where: { conversation_id: conversationId, ...beforeWhere },
      order: [['createdAt', 'DESC'], ['id', 'DESC']],
      limit: limit + 1,
      transaction
    });
    const hasMore = records.length > limit;
    const pageDescending = hasMore ? records.slice(0, limit) : records;
    const oldestReturned = pageDescending.at(-1) || null;
    const pageAscending = [...pageDescending].reverse();

    const readFields = getReadFields(context.conversation, userId);
    const partnerReadCursorMessage = await loadMessageInConversation(
      readFields.partnerLastReadMessageId,
      conversationId,
      transaction
    );

    response = {
      messages: pageAscending.map((message) => buildMessageDto({
        message,
        requesterUserId: userId,
        conversation: context.conversation,
        partnerReadCursorMessage
      })),
      next_cursor: hasMore && oldestReturned
        ? encodeMessageCursor({
            conversationId,
            createdAt: oldestReturned.createdAt,
            id: oldestReturned.id
          })
        : null,
      has_more: hasMore
    };
  });

  if (deferredError) throw deferredError;
  return response;
};

export { buildMessageDto, getMessageHistoryService, sendMessageService };
