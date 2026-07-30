import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

const OAUTH_LINK_STATE_TTL_SECONDS = 10 * 60;
const OAUTH_LINK_STATE_MAX_ENTRIES = 1000;
const ALLOWED_PROVIDERS = new Set(['google', 'facebook']);
const stateRegistry = new Map();

class OAuthLinkStateError extends Error {
  constructor(message, code = 'OAUTH_LINK_STATE_INVALID', status = 400) {
    super(message);
    this.name = 'OAuthLinkStateError';
    this.code = code;
    this.status = status;
  }
}

const normalizeProvider = (provider) => {
  const normalized = String(provider || '').trim().toLowerCase();
  if (!ALLOWED_PROVIDERS.has(normalized)) {
    throw new OAuthLinkStateError('The social provider is unsupported.', 'OAUTH_PROVIDER_UNSUPPORTED');
  }
  return normalized;
};

const pruneExpiredStates = (nowMs = Date.now()) => {
  stateRegistry.forEach((entry, jti) => {
    if (entry.expiresAtMs <= nowMs) stateRegistry.delete(jti);
  });
};

const isOAuthLinkAuthVersionCurrent = (stateAuthVersion, currentAuthVersion) => (
  Number.isInteger(stateAuthVersion)
  && Number(stateAuthVersion) === Number(currentAuthVersion)
);

const verifyState = (state, expectedProvider, nowMs = Date.now()) => {
  if (!state || typeof state !== 'string') {
    throw new OAuthLinkStateError('The social-link state is missing.');
  }
  const provider = normalizeProvider(expectedProvider);
  let decoded;
  try {
    decoded = jwt.verify(state, process.env.JWT_ACCESS_SECRET);
  } catch {
    throw new OAuthLinkStateError('The social-link state is invalid or expired.');
  }
  if (
    decoded.action !== 'link_social_provider'
    || decoded.provider !== provider
    || typeof decoded.jti !== 'string'
    || typeof decoded.sub !== 'string'
    || !['CUSTOMER', 'HANDYMAN'].includes(decoded.role)
    || !Number.isInteger(decoded.auth_version)
    || !Number.isFinite(decoded.exp)
    || decoded.exp * 1000 <= nowMs
  ) {
    throw new OAuthLinkStateError('The social-link state is invalid.');
  }
  return decoded;
};

const issueOAuthLinkState = ({ user, provider, nowMs = Date.now() }) => {
  const normalizedProvider = normalizeProvider(provider);
  if (!user?.id || !['CUSTOMER', 'HANDYMAN'].includes(user.role)) {
    throw new OAuthLinkStateError('The current account cannot link social providers.', 'OAUTH_LINK_NOT_ALLOWED', 403);
  }
  if (!String(process.env.JWT_ACCESS_SECRET || '').trim()) {
    throw new OAuthLinkStateError('Social-link signing is unavailable.', 'OAUTH_LINK_STATE_UNAVAILABLE', 503);
  }

  pruneExpiredStates(nowMs);
  if (stateRegistry.size >= OAUTH_LINK_STATE_MAX_ENTRIES) {
    throw new OAuthLinkStateError('Too many social-link attempts are active.', 'OAUTH_LINK_STATE_CAPACITY', 503);
  }

  const jti = crypto.randomUUID();
  const expiresAtMs = nowMs + OAUTH_LINK_STATE_TTL_SECONDS * 1000;
  const state = jwt.sign(
    {
      action: 'link_social_provider',
      provider: normalizedProvider,
      role: user.role,
      auth_version: Number(user.auth_version || 0),
    },
    process.env.JWT_ACCESS_SECRET,
    {
      expiresIn: OAUTH_LINK_STATE_TTL_SECONDS,
      jwtid: jti,
      subject: String(user.id),
    },
  );

  stateRegistry.set(jti, {
    provider: normalizedProvider,
    userId: String(user.id),
    phase: 'ISSUED',
    expiresAtMs,
  });
  return { state, expiresInSeconds: OAUTH_LINK_STATE_TTL_SECONDS };
};

const transitionState = ({ state, provider, expectedPhase, nextPhase = null, nowMs = Date.now() }) => {
  pruneExpiredStates(nowMs);
  const decoded = verifyState(state, provider, nowMs);
  const entry = stateRegistry.get(decoded.jti);
  if (
    !entry
    || entry.phase !== expectedPhase
    || entry.provider !== decoded.provider
    || entry.userId !== decoded.sub
  ) {
    throw new OAuthLinkStateError('The social-link state was already used or is unavailable.');
  }

  if (nextPhase) {
    entry.phase = nextPhase;
  } else {
    stateRegistry.delete(decoded.jti);
  }
  return decoded;
};

const claimOAuthLinkState = ({ state, provider, nowMs }) => transitionState({
  state,
  provider,
  expectedPhase: 'ISSUED',
  nextPhase: 'IN_FLIGHT',
  nowMs,
});

const consumeOAuthLinkState = ({ state, provider, nowMs }) => transitionState({
  state,
  provider,
  expectedPhase: 'IN_FLIGHT',
  nowMs,
});

const discardOAuthLinkState = ({ state, provider }) => {
  try {
    const decoded = verifyState(state, provider);
    stateRegistry.delete(decoded.jti);
  } catch {
    // Invalid state is already unusable and must not produce extra detail.
  }
};

const resetOAuthLinkStateRegistryForTests = () => {
  stateRegistry.clear();
};

export {
  OAUTH_LINK_STATE_MAX_ENTRIES,
  OAUTH_LINK_STATE_TTL_SECONDS,
  OAuthLinkStateError,
  claimOAuthLinkState,
  consumeOAuthLinkState,
  discardOAuthLinkState,
  issueOAuthLinkState,
  isOAuthLinkAuthVersionCurrent,
  resetOAuthLinkStateRegistryForTests,
};
