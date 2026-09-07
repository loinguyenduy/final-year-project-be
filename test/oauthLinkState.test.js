import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OAUTH_LINK_STATE_TTL_SECONDS,
  claimOAuthLinkState,
  consumeOAuthLinkState,
  issueOAuthLinkState,
  isOAuthLinkAuthVersionCurrent,
  resetOAuthLinkStateRegistryForTests,
} from '../src/modules/identity/services/OAuthLinkState.service.js';

process.env.JWT_ACCESS_SECRET = 'synthetic-oauth-link-state-test-secret';

const user = {
  id: '00000000-0000-4000-8000-000000000001',
  role: 'CUSTOMER',
  auth_version: 4,
};

test.beforeEach(() => resetOAuthLinkStateRegistryForTests());

test('state is issued, claimed, consumed once, and preserves auth_version', () => {
  const { state } = issueOAuthLinkState({ user, provider: 'google' });
  const claimed = claimOAuthLinkState({ state, provider: 'google' });
  assert.equal(claimed.sub, user.id);
  assert.equal(claimed.auth_version, user.auth_version);
  consumeOAuthLinkState({ state, provider: 'google' });
  assert.throws(() => consumeOAuthLinkState({ state, provider: 'google' }));
});

test('provider mismatch is rejected without consuming a valid state', () => {
  const { state } = issueOAuthLinkState({ user, provider: 'google' });
  assert.throws(() => claimOAuthLinkState({ state, provider: 'facebook' }));
  assert.doesNotThrow(() => claimOAuthLinkState({ state, provider: 'google' }));
});

test('expired state is rejected', () => {
  const nowMs = Date.now();
  const { state } = issueOAuthLinkState({ user, provider: 'facebook', nowMs });
  assert.throws(() => claimOAuthLinkState({
    state,
    provider: 'facebook',
    nowMs: nowMs + (OAUTH_LINK_STATE_TTL_SECONDS + 1) * 1000,
  }));
});

test('a changed auth_version is detectable before provider persistence', () => {
  const { state } = issueOAuthLinkState({ user, provider: 'google' });
  const claimed = claimOAuthLinkState({ state, provider: 'google' });
  const currentAuthVersion = user.auth_version + 1;
  assert.equal(
    isOAuthLinkAuthVersionCurrent(claimed.auth_version, currentAuthVersion),
    false,
  );
});
