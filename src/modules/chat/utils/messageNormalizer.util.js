import { MESSAGE_MAX_LENGTH } from '../constants/chat.constants.js';
import { chatError } from './chatError.util.js';

const normalizeMessageContent = (content) => {
  if (typeof content !== 'string') {
    throw chatError('Message content must be a string.', 400, 'INVALID_MESSAGE_CONTENT');
  }

  const normalized = content
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
    .trim();

  if (!normalized) {
    throw chatError('Message content must not be empty.', 400, 'INVALID_MESSAGE_CONTENT');
  }
  if (Array.from(normalized).length > MESSAGE_MAX_LENGTH) {
    throw chatError(
      `Message content must not exceed ${MESSAGE_MAX_LENGTH} characters.`,
      400,
      'MESSAGE_TOO_LONG'
    );
  }

  return normalized;
};

export { normalizeMessageContent };
