import {
  AI_COMPLEXITIES,
  AI_MODEL_STAGES,
  AI_SEVERITIES,
  AI_URGENCIES
} from '../constants/ai.constants.js';
import AiError from '../utils/AiError.js';

const CONTROL_PATTERN = /\p{Cc}/u;
const HTML_PATTERN = /<\/?[a-z][^>]*>/i;

const RESPONSE_KEYS = new Set([
  'assistant_message',
  'device_age_or_usage_duration',
  'device_or_work_area',
  'stage',
  'service_code',
  'problem_summary',
  'symptoms',
  'keywords',
  'severity',
  'urgency',
  'complexity',
  'missing_information',
  'follow_up_questions',
  'form_patch',
  'safety_message'
]);

const normalizeText = (value, {
  field,
  maximum,
  nullable = false,
  minimum = 0
}) => {
  if (value === null && nullable) return null;
  if (typeof value !== 'string') {
    throw new AiError(`${field} must be plain text.`, 502, 'AI_RESPONSE_INVALID');
  }
  const normalized = value.normalize('NFC').trim().replace(/[ \t]{2,}/g, ' ');
  if (nullable && !normalized) return null;
  if (normalized.length < minimum
    || normalized.length > maximum
    || CONTROL_PATTERN.test(normalized)
    || HTML_PATTERN.test(normalized)) {
    throw new AiError(`${field} is invalid.`, 502, 'AI_RESPONSE_INVALID');
  }
  return normalized;
};

const normalizeArray = (value, { field, maximumItems, itemMaximum }) => {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new AiError(`${field} is invalid.`, 502, 'AI_RESPONSE_INVALID');
  }
  const normalized = value.map((entry, index) => normalizeText(entry, {
    field: `${field}[${index}]`,
    maximum: itemMaximum,
    minimum: 1
  }));
  return [...new Set(normalized)];
};

const requireEnum = (value, allowed, field) => {
  if (!allowed.includes(value)) {
    throw new AiError(`${field} is invalid.`, 502, 'AI_RESPONSE_INVALID');
  }
  return value;
};

const validateAiStructuredResponse = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AiError('Gemini returned an invalid response object.', 502, 'AI_RESPONSE_INVALID');
  }
  const unknownKeys = Object.keys(value).filter((key) => !RESPONSE_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new AiError('Gemini returned unsupported fields.', 502, 'AI_RESPONSE_INVALID');
  }
  if (!value.form_patch || typeof value.form_patch !== 'object' || Array.isArray(value.form_patch)) {
    throw new AiError('form_patch is invalid.', 502, 'AI_RESPONSE_INVALID');
  }
  const patchKeys = Object.keys(value.form_patch);
  if (patchKeys.some((key) => key !== 'issue_description')) {
    throw new AiError('form_patch contains unsupported fields.', 502, 'AI_RESPONSE_INVALID');
  }

  const serviceCode = value.service_code === null
    ? null
    : normalizeText(value.service_code, {
      field: 'service_code',
      maximum: 50,
      nullable: true
    })?.toUpperCase() || null;

  return {
    assistant_message: normalizeText(value.assistant_message, {
      field: 'assistant_message',
      maximum: 2000,
      minimum: 1
    }),
    stage: requireEnum(value.stage, AI_MODEL_STAGES, 'stage'),
    device_or_work_area: normalizeText(value.device_or_work_area, {
      field: 'device_or_work_area',
      maximum: 200,
      nullable: true
    }),
    device_age_or_usage_duration: normalizeText(value.device_age_or_usage_duration, {
      field: 'device_age_or_usage_duration',
      maximum: 200,
      nullable: true
    }),
    service_code: serviceCode,
    problem_summary: normalizeText(value.problem_summary, {
      field: 'problem_summary',
      maximum: 1000,
      nullable: true
    }),
    symptoms: normalizeArray(value.symptoms, {
      field: 'symptoms',
      maximumItems: 8,
      itemMaximum: 200
    }),
    keywords: normalizeArray(value.keywords, {
      field: 'keywords',
      maximumItems: 8,
      itemMaximum: 100
    }),
    severity: requireEnum(value.severity, AI_SEVERITIES, 'severity'),
    urgency: requireEnum(value.urgency, AI_URGENCIES, 'urgency'),
    complexity: requireEnum(value.complexity, AI_COMPLEXITIES, 'complexity'),
    missing_information: normalizeArray(value.missing_information, {
      field: 'missing_information',
      maximumItems: 5,
      itemMaximum: 200
    }),
    follow_up_questions: normalizeArray(value.follow_up_questions, {
      field: 'follow_up_questions',
      maximumItems: 3,
      itemMaximum: 300
    }),
    form_patch: {
      issue_description: normalizeText(value.form_patch.issue_description, {
        field: 'form_patch.issue_description',
        maximum: 2000,
        nullable: true
      })
    },
    safety_message: normalizeText(value.safety_message, {
      field: 'safety_message',
      maximum: 1000,
      nullable: true
    })
  };
};

const FORBIDDEN_MARKETPLACE_CLAIMS = Object.freeze([
  /\bwe(?:'ll| will)\s+(?:send|assign|dispatch)\s+(?:a\s+)?(?:technician|handyman)\b/iu,
  /\b(?:a\s+)?(?:technician|handyman)\s+(?:has been|is|will be)\s+assigned\b/iu,
  /\bthe (?:problem|issue|fault)\s+is definitely caused by\b/iu,
  /\bdefinitely\s+(?:caused by|means|is)\b/iu,
  /\bchúng tôi sẽ\s+(?:cử|gửi|điều)\s+(?:một\s+)?(?:kỹ thuật viên|handyman)\b/iu,
  /\b(?:kỹ thuật viên|handyman)\s+(?:đã|sẽ)\s+được\s+(?:cử|phân công|điều)\b/iu,
  /\b(?:vấn đề|sự cố|lỗi)\s+chắc chắn\s+(?:do|bởi|là)\b/iu
]);

const assertMarketplaceSafeResponse = (response) => {
  const visibleText = [
    response.assistant_message,
    response.safety_message,
    response.problem_summary,
    response.form_patch?.issue_description,
    response.device_or_work_area,
    response.device_age_or_usage_duration,
    ...(response.symptoms || []),
    ...(response.follow_up_questions || [])
  ].filter(Boolean).join('\n');
  if (FORBIDDEN_MARKETPLACE_CLAIMS.some((pattern) => pattern.test(visibleText))) {
    throw new AiError(
      'Gemini returned an unsupported marketplace or diagnosis claim.',
      502,
      'AI_RESPONSE_INVALID'
    );
  }
  return response;
};

export {
  assertMarketplaceSafeResponse,
  validateAiStructuredResponse
};
