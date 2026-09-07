const positiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

// Định nghĩa các giá trị mặc định cho cấu hình AI.
// Các giá trị này được sử dụng nếu không có giá trị tương ứng trong biến môi trường.
const AI_DEFAULTS = Object.freeze({
  requestTimeoutMs: 20000,
  maxTurns: 8,
  maxRecalculations: 2,
  sessionTtlMinutes: 1440,
  maxActiveSessionsPerCustomer: 3,
  rateLimitWindowMs: 900000,
  rateLimitMax: 20,
  promptVersion: 'job-diagnosis-language-confirmation-v2',
  estimatorVersion: 'historical-bid-v1',
  minPriceSamples: 3,
  maxHistoricalCandidates: 100,
  maxComparableResults: 30,
  maxContextMessages: 12
});

// Đọc cấu hình AI 
const getAiConfig = () => ({
  apiKey: String(process.env.GEMINI_API_KEY || '').trim(),
  model: String(process.env.GEMINI_MODEL || '').trim(),
  requestTimeoutMs: positiveInteger(
    process.env.AI_REQUEST_TIMEOUT_MS,
    AI_DEFAULTS.requestTimeoutMs
  ),
  maxTurns: positiveInteger(process.env.AI_MAX_TURNS, AI_DEFAULTS.maxTurns),
  maxRecalculations: positiveInteger(
    process.env.AI_MAX_RECALCULATIONS,
    AI_DEFAULTS.maxRecalculations
  ),
  sessionTtlMinutes: positiveInteger(
    process.env.AI_SESSION_TTL_MINUTES,
    AI_DEFAULTS.sessionTtlMinutes
  ),
  maxActiveSessionsPerCustomer: positiveInteger(
    process.env.AI_MAX_ACTIVE_SESSIONS_PER_CUSTOMER,
    AI_DEFAULTS.maxActiveSessionsPerCustomer
  ),
  rateLimitWindowMs: positiveInteger(
    process.env.AI_RATE_LIMIT_WINDOW_MS,
    AI_DEFAULTS.rateLimitWindowMs
  ),
  rateLimitMax: positiveInteger(process.env.AI_RATE_LIMIT_MAX, AI_DEFAULTS.rateLimitMax),
  promptVersion: String(
    process.env.AI_PROMPT_VERSION || AI_DEFAULTS.promptVersion
  ).trim(),
  estimatorVersion: String(
    process.env.AI_ESTIMATOR_VERSION || AI_DEFAULTS.estimatorVersion
  ).trim(),
  minPriceSamples: positiveInteger(
    process.env.AI_MIN_PRICE_SAMPLES,
    AI_DEFAULTS.minPriceSamples
  ),
  maxHistoricalCandidates: Math.min(
    positiveInteger(
      process.env.AI_MAX_HISTORICAL_CANDIDATES,
      AI_DEFAULTS.maxHistoricalCandidates
    ),
    500
  ),
  maxComparableResults: Math.min(
    positiveInteger(
      process.env.AI_MAX_COMPARABLE_RESULTS,
      AI_DEFAULTS.maxComparableResults
    ),
    100
  ),
  maxContextMessages: AI_DEFAULTS.maxContextMessages
});

export { AI_DEFAULTS, getAiConfig };
