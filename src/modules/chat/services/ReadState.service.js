import db from '../../../core/database/connection.js';
import Message from '../models/Message.model.js';
import { chatError } from '../utils/chatError.util.js';
import { isValidUuid } from '../utils/chatValidation.util.js';
import { compareMessagePosition } from '../utils/messageOrder.util.js';
import { getLockedConversationContext } from './ChatAccess.service.js';
import { getReadFields } from './Conversation.service.js';

const markConversationReadService = async ({ conversationId, userId, lastMessageId }) => {
  if (!isValidUuid(conversationId) || !isValidUuid(lastMessageId)) {
    throw chatError('Invalid conversation_id or last_message_id.', 400, 'VALIDATION_ERROR');
  }

  let result;
  let deferredError = null;
  await db.transaction(async (transaction) => {
    const context = await getLockedConversationContext({
      conversationId,
      userId,
      transaction
    });
    if (context.accessError) {
      deferredError = context.accessError;
      return;
    }

    const targetMessage = await Message.findOne({
      where: { id: lastMessageId, conversation_id: conversationId },
      transaction
    });
    if (!targetMessage) {
      throw chatError('Message not found in this conversation.', 400, 'INVALID_LAST_MESSAGE_ID');
    }

    const readFields = getReadFields(context.conversation, userId);
    const currentCursor = readFields.currentLastReadMessageId
      ? await Message.findOne({
          where: {
            id: readFields.currentLastReadMessageId,
            conversation_id: conversationId
          },
          transaction
        })
      : null;

    if (readFields.currentLastReadMessageId && !currentCursor) {
      throw chatError('Read cursor data is inconsistent.', 409, 'READ_STATE_INCONSISTENT');
    }

    const shouldAdvance = !currentCursor
      || compareMessagePosition(targetMessage, currentCursor) > 0;
    const isCustomer = context.conversation.customer_id === userId;

    if (shouldAdvance) {
      const readAt = new Date();
      const updates = isCustomer
        ? {
            customer_last_read_message_id: targetMessage.id,
            customer_last_read_at: readAt
          }
        : {
            handyman_last_read_message_id: targetMessage.id,
            handyman_last_read_at: readAt
          };
      await context.conversation.update(updates, { transaction });
    }

    const refreshedReadFields = getReadFields(context.conversation, userId);
    result = {
      conversation_id: context.conversation.id,
      user_id: userId,
      role: context.currentUser.role,
      last_read_message_id: refreshedReadFields.currentLastReadMessageId,
      read_at: refreshedReadFields.currentLastReadAt,
      advanced: shouldAdvance
    };
  });

  if (deferredError) throw deferredError;
  return result;
};

export { markConversationReadService };
