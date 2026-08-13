import { randomUUID } from 'node:crypto';
import AiError from '../utils/AiError.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_PATTERN = /\p{Cc}/u;
const HTML_PATTERN = /<\/?[a-z][^>]*>/i;

// Kiểm tra xem một giá trị có phải là một số nguyên dương hay không, nếu không thì trả về giá trị mặc định.
const assertPlainObject = (value, allowedFields, label = 'Request body') => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AiError(`${label} must be an object.`, 400, 'VALIDATION_ERROR');
  }
  const unknown = Object.keys(value).filter((field) => !allowedFields.includes(field));
  if (unknown.length > 0) {
    throw new AiError(
      `Unsupported fields: ${unknown.join(', ')}.`,
      400,
      'VALIDATION_ERROR'
    );
  }
};

// Chuẩn hóa văn bản đầu vào từ khách hàng, loại bỏ các ký tự không hợp lệ và kiểm tra độ dài.
const normalizeCustomerText = (value, field = 'message', maximum = 2000) => {
  if (typeof value !== 'string') {
    throw new AiError(`${field} must be plain text.`, 400, 'VALIDATION_ERROR');
  }
  const normalized = value.normalize('NFC').trim().replace(/[ \t]{2,}/g, ' ');
  if (!normalized
    || normalized.length > maximum
    || CONTROL_PATTERN.test(normalized)
    || HTML_PATTERN.test(normalized)) {
    throw new AiError(
      `${field} must be plain text between 1 and ${maximum} characters.`,
      400,
      'VALIDATION_ERROR'
    );
  }
  return normalized;
};

const normalizeClientMessageId = (value) => {
  if (value === undefined || value === null || value === '') return randomUUID();
  if (typeof value !== 'string' || !UUID_PATTERN.test(value.trim())) {
    throw new AiError('client_message_id must be a UUID.', 400, 'VALIDATION_ERROR');
  }
  return value.trim().toLowerCase();
};

const normalizeUuid = (value, field) => {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value.trim())) {
    throw new AiError(`${field} must be a UUID.`, 400, 'VALIDATION_ERROR');
  }
  return value.trim().toLowerCase();
};

const normalizeExpectedRevision = (value) => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AiError(
      'expected_revision must be a non-negative integer.',
      400,
      'VALIDATION_ERROR'
    );
  }
  return parsed;
};

export {
  UUID_PATTERN,
  assertPlainObject,
  normalizeClientMessageId,
  normalizeCustomerText,
  normalizeExpectedRevision,
  normalizeUuid
};
