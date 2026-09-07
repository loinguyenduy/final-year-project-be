import { rateLimit } from 'express-rate-limit';
import dotenv from 'dotenv';

dotenv.config();

const positiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

// Tạo một middleware rate limiter với các tùy chọn được cung cấp.
const createLimiter = ({ windowMinutes, maxRequests }) => rateLimit({
  windowMs: windowMinutes * 60 * 1000,
  limit: maxRequests,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({
    EM: 'Too many requests. Please try again later.',
    EC: 429,
    code: 'RATE_LIMITED',
    DT: ''
  })
});

// Limit khi người dùng đăng nhập với vai trò participant (CUSTOMER hoặc HANDYMAN)
const participantLoginRateLimiter = createLimiter({
  windowMinutes: positiveInteger(process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW_MINUTES, 15),
  maxRequests: positiveInteger(process.env.AUTH_LOGIN_RATE_LIMIT_MAX_ATTEMPTS, 10)
});

// Limit khi người dùng đăng nhập với vai trò admin
const adminLoginRateLimiter = createLimiter({
  windowMinutes: positiveInteger(process.env.ADMIN_LOGIN_RATE_LIMIT_WINDOW_MINUTES, 15),
  maxRequests: positiveInteger(process.env.ADMIN_LOGIN_RATE_LIMIT_MAX_ATTEMPTS, 5)
});

// Limit khi admin thực hiện các hành động liên quan đến mật khẩu (ví dụ: reset password, change password)
const adminMutationRateLimiter = createLimiter({
  windowMinutes: positiveInteger(process.env.ADMIN_MUTATION_RATE_LIMIT_WINDOW_MINUTES, 5),
  maxRequests: positiveInteger(process.env.ADMIN_MUTATION_RATE_LIMIT_MAX_REQUESTS, 30)
});

// Limit khi người dùng thực hiện các hành động liên quan đến mật khẩu (ví dụ: reset password, change password)
const passwordActionRateLimiter = createLimiter({
  windowMinutes: positiveInteger(process.env.PASSWORD_ACTION_RATE_LIMIT_WINDOW_MINUTES, 15),
  maxRequests: positiveInteger(process.env.PASSWORD_ACTION_RATE_LIMIT_MAX_REQUESTS, 5)
});

const aiWindowMs = positiveInteger(process.env.AI_RATE_LIMIT_WINDOW_MS, 900000);
const aiMaxRequests = positiveInteger(process.env.AI_RATE_LIMIT_MAX, 20);

// Limit khi người dùng gửi yêu cầu đến AI assistant (dựa trên IP)
const aiLimiterOptions = {
  windowMs: aiWindowMs,
  limit: aiMaxRequests,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({
    EM: 'Too many AI assistant requests. Please try again later.',
    EC: 429,
    code: 'RATE_LIMITED',
    DT: ''
  })
};

const aiIpRateLimiter = rateLimit(aiLimiterOptions);
const aiCustomerRateLimiter = rateLimit({
  ...aiLimiterOptions,
  keyGenerator: (req) => String(req.user?.id || 'unauthenticated')
});

export {
  adminLoginRateLimiter,
  adminMutationRateLimiter,
  aiCustomerRateLimiter,
  aiIpRateLimiter,
  passwordActionRateLimiter,
  participantLoginRateLimiter
};
