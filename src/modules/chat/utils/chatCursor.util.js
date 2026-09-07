import { chatError } from './chatError.util.js';
import { isValidUuid } from './chatValidation.util.js';

const encodeMessageCursor = ({ conversationId, createdAt, id }) => {
  const payload = JSON.stringify({
    v: 1,
    conversation_id: conversationId,
    created_at: new Date(createdAt).toISOString(),
    id
  });
  return Buffer.from(payload, 'utf8').toString('base64url');
};

const decodeMessageCursor = (cursor, expectedConversationId) => {
  try {
    const decoded = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    const createdAt = new Date(decoded.created_at);

    if (decoded.v !== 1
      || decoded.conversation_id !== expectedConversationId
      || !isValidUuid(decoded.id)
      || Number.isNaN(createdAt.getTime())) {
      throw new Error('Invalid cursor fields.');
    }

    return { id: decoded.id, createdAt };
  } catch (_error) {
    throw chatError('Invalid message cursor.', 400, 'INVALID_CURSOR');
  }
};

export { decodeMessageCursor, encodeMessageCursor };
