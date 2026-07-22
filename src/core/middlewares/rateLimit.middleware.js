import { rateLimit } from 'express-rate-limit';
import dotenv from 'dotenv';

dotenv.config();

const positiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

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

const participantLoginRateLimiter = createLimiter({
  windowMinutes: positiveInteger(process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW_MINUTES, 15),
  maxRequests: positiveInteger(process.env.AUTH_LOGIN_RATE_LIMIT_MAX_ATTEMPTS, 10)
});

const adminLoginRateLimiter = createLimiter({
  windowMinutes: positiveInteger(process.env.ADMIN_LOGIN_RATE_LIMIT_WINDOW_MINUTES, 15),
  maxRequests: positiveInteger(process.env.ADMIN_LOGIN_RATE_LIMIT_MAX_ATTEMPTS, 5)
});

const adminMutationRateLimiter = createLimiter({
  windowMinutes: positiveInteger(process.env.ADMIN_MUTATION_RATE_LIMIT_WINDOW_MINUTES, 5),
  maxRequests: positiveInteger(process.env.ADMIN_MUTATION_RATE_LIMIT_MAX_REQUESTS, 30)
});

const passwordActionRateLimiter = createLimiter({
  windowMinutes: positiveInteger(process.env.PASSWORD_ACTION_RATE_LIMIT_WINDOW_MINUTES, 15),
  maxRequests: positiveInteger(process.env.PASSWORD_ACTION_RATE_LIMIT_MAX_REQUESTS, 5)
});

export {
  adminLoginRateLimiter,
  adminMutationRateLimiter,
  passwordActionRateLimiter,
  participantLoginRateLimiter
};
