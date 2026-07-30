const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const HTML_TAG_PATTERN = /<\/?[a-z][^>]*>/i;

class AdminManagementError extends Error {
  constructor(message, status = 400, code = 'VALIDATION_ERROR', data = '') {
    super(message);
    this.name = 'AdminManagementError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

const assertUuid = (value, field = 'id') => {
  if (!UUID_PATTERN.test(String(value || ''))) {
    throw new AdminManagementError(`${field} must be a valid UUID.`);
  }
  return String(value);
};

const parsePositiveInteger = (value, field, fallback, maximum = 100) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) throw new AdminManagementError(`${field} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new AdminManagementError(`${field} must be between 1 and ${maximum}.`);
  }
  return parsed;
};

const parseBoolean = (value, field) => {
  if (value === undefined || value === null || value === '' || value === 'ALL') return null;
  const normalized = String(value).toLowerCase();
  if (!['true', 'false'].includes(normalized)) {
    throw new AdminManagementError(`${field} must be true or false.`);
  }
  return normalized === 'true';
};

const normalizeSearch = (value, maximum = 100) => {
  const normalized = String(value || '').trim().normalize('NFC').replace(/[%_]/g, ' ').replace(/\s+/g, ' ');
  if (normalized.length > maximum) throw new AdminManagementError(`search must not exceed ${maximum} characters.`);
  return normalized;
};

const parseDate = (value, field, endOfDay = false) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new AdminManagementError(`${field} must be a valid date.`);
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) parsed.setUTCHours(23, 59, 59, 999);
  return parsed;
};

const normalizePlainText = (value, field, maximum, { required = false } = {}) => {
  if (value === undefined || value === null) {
    if (required) throw new AdminManagementError(`${field} is required.`, 400, 'VALIDATION_ERROR');
    return null;
  }
  if (typeof value !== 'string') throw new AdminManagementError(`${field} must be plain text.`);
  const normalized = value.trim().normalize('NFC').replace(/ {2,}/g, ' ');
  if (!normalized && required) throw new AdminManagementError(`${field} is required.`);
  if (normalized.length > maximum || CONTROL_CHARACTER_PATTERN.test(normalized) || HTML_TAG_PATTERN.test(normalized)) {
    throw new AdminManagementError(`${field} contains unsupported content.`);
  }
  return normalized || null;
};

export {
  AdminManagementError,
  assertUuid,
  normalizePlainText,
  normalizeSearch,
  parseBoolean,
  parseDate,
  parsePositiveInteger
};
