const REFILL_RATE_PER_SECOND = 5;
const BUCKET_CAPACITY = 10;
const STALE_BUCKET_MS = 15 * 60 * 1000;

const buckets = new Map();

const pruneStaleBuckets = (now) => {
  if (buckets.size < 1000) return;
  for (const [userId, bucket] of buckets.entries()) {
    if (now - bucket.lastSeenAt > STALE_BUCKET_MS) buckets.delete(userId);
  }
};

const consumeMessageToken = (userId) => {
  const now = Date.now();
  pruneStaleBuckets(now);

  const existing = buckets.get(userId) || {
    tokens: BUCKET_CAPACITY,
    lastRefillAt: now,
    lastSeenAt: now
  };

  const elapsedSeconds = Math.max(0, now - existing.lastRefillAt) / 1000;
  const tokens = Math.min(
    BUCKET_CAPACITY,
    existing.tokens + (elapsedSeconds * REFILL_RATE_PER_SECOND)
  );

  if (tokens < 1) {
    const retryAfterMs = Math.ceil(((1 - tokens) / REFILL_RATE_PER_SECOND) * 1000);
    buckets.set(userId, {
      tokens,
      lastRefillAt: now,
      lastSeenAt: now
    });
    return { allowed: false, retryAfterMs };
  }

  buckets.set(userId, {
    tokens: tokens - 1,
    lastRefillAt: now,
    lastSeenAt: now
  });
  return { allowed: true, retryAfterMs: 0 };
};

export { consumeMessageToken };
