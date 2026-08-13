import crypto from 'crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Middleware để gán correlationId cho mỗi request.
const correlationIdMiddleware = (req, res, next) => {
  const incomingId = String(req.get('X-Correlation-ID') || '').trim();
  const correlationId = UUID_PATTERN.test(incomingId)
    ? incomingId.toLowerCase()
    : crypto.randomUUID();

  req.correlationId = correlationId;
  res.setHeader('X-Correlation-ID', correlationId);
  next();
};

export { correlationIdMiddleware };
