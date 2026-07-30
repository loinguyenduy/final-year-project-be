import passport, {
  isOAuthProviderConfigured,
} from '../../../core/middlewares/passport.middleware.js';
import {
  buildFrontendUrl,
  getFrontendOrigin,
} from '../../../core/config/publicUrls.config.js';
import {
  upsertGoogleUser,
  upsertFacebookUser,
  linkGoogleProvider,
  linkFacebookProvider,
} from '../services/SocialAuth.service.js';
import {
  OAuthLinkStateError,
  claimOAuthLinkState,
  consumeOAuthLinkState,
  discardOAuthLinkState,
  issueOAuthLinkState,
} from '../services/OAuthLinkState.service.js';
import { setRefreshCookie } from '../utils/authCookie.util.js';

const PROVIDER_SCOPES = Object.freeze({
  google: ['profile', 'email'],
  facebook: ['public_profile', 'email'],
});

const loginRedirect = (error) => buildFrontendUrl('/login', { error });
const linkRedirect = (query) => buildFrontendUrl('/social-link-callback', query);

const requireOAuthProvider = (provider, { callback = false } = {}) => (req, res, next) => {
  let frontendConfigured = true;
  try {
    getFrontendOrigin();
  } catch {
    frontendConfigured = false;
  }
  if (isOAuthProviderConfigured(provider) && frontendConfigured) return next();
  if (callback) {
    if (!frontendConfigured) {
      return res.status(503).json({
        EM: 'Social authentication is temporarily unavailable.',
        EC: 503,
        code: 'OAUTH_FRONTEND_URL_UNAVAILABLE',
        DT: '',
      });
    }
    if (typeof req.query.state === 'string' && req.query.state) {
      discardOAuthLinkState({ state: req.query.state, provider });
      return res.redirect(linkRedirect({ error: 'oauth_provider_unavailable' }));
    }
    return res.redirect(loginRedirect('oauth_provider_unavailable'));
  }
  return res.status(503).json({
    EM: 'This social login provider is temporarily unavailable.',
    EC: 503,
    code: 'OAUTH_PROVIDER_UNAVAILABLE',
    DT: '',
  });
};

const beginOAuth = (provider) => passport.authenticate(provider, {
  scope: PROVIDER_SCOPES[provider],
  session: false,
});

const authenticateOAuthCallback = (provider) => (req, res, next) => {
  passport.authenticate(provider, { session: false }, (error, profile) => {
    if (!error && profile) {
      req.user = profile;
      return next();
    }

    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (state) {
      discardOAuthLinkState({ state, provider });
      return res.redirect(linkRedirect({ error: 'oauth_provider_failed' }));
    }
    return res.redirect(loginRedirect('oauth_provider_failed'));
  })(req, res, next);
};

const issueLinkState = (provider) => (req, res) => {
  try {
    const issued = issueOAuthLinkState({ user: req.user, provider });
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({
      EM: 'Social-link state created.',
      EC: 0,
      DT: {
        state: issued.state,
        expires_in: issued.expiresInSeconds,
      },
    });
  } catch (error) {
    const status = error instanceof OAuthLinkStateError ? error.status : 500;
    return res.status(status).json({
      EM: status === 500
        ? 'Unable to start social account linking.'
        : error.message,
      EC: status,
      code: error.code || 'OAUTH_LINK_STATE_FAILED',
      DT: '',
    });
  }
};

const initiateLink = (provider) => (req, res, next) => {
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  try {
    claimOAuthLinkState({ state, provider });
    return passport.authenticate(provider, {
      scope: PROVIDER_SCOPES[provider],
      session: false,
      state,
    })(req, res, next);
  } catch {
    return res.redirect(linkRedirect({ error: 'invalid_link_state' }));
  }
};

const completeSocialLogin = async ({ provider, profile, upsertUser, res }) => {
  const result = await upsertUser(profile);
  if (result.EC === 0) {
    setRefreshCookie(res, result.DT.refresh_token);
    delete result.DT.refresh_token;
    return res.redirect(buildFrontendUrl('/social-callback'));
  }
  if (result.code === 'ADMIN_PORTAL_REQUIRED') {
    return res.redirect(loginRedirect('admin_portal_required'));
  }
  return res.redirect(loginRedirect(`${provider}_auth_failed`));
};

const completeSocialLink = async ({
  provider,
  profile,
  state,
  linkProvider,
  res,
}) => {
  try {
    const linkState = consumeOAuthLinkState({ state, provider });
    const result = await linkProvider(linkState.sub, profile, {
      expectedAuthVersion: linkState.auth_version,
    });
    if (result.EC === 0) {
      return res.redirect(linkRedirect({ linked: provider }));
    }
    return res.redirect(linkRedirect({ error: result.code || 'social_link_failed' }));
  } catch {
    return res.redirect(linkRedirect({ error: 'invalid_link_state' }));
  }
};

const handleGoogleCallback = async (req, res) => {
  try {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (state) {
      return await completeSocialLink({
        provider: 'google',
        profile: req.user,
        state,
        linkProvider: linkGoogleProvider,
        res,
      });
    }
    return await completeSocialLogin({
      provider: 'google',
      profile: req.user,
      upsertUser: upsertGoogleUser,
      res,
    });
  } catch (error) {
    console.error('Google OAuth callback failed:', error?.message || 'unknown error');
    return res.redirect(loginRedirect('server_error'));
  }
};

const handleFacebookCallback = async (req, res) => {
  try {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (state) {
      return await completeSocialLink({
        provider: 'facebook',
        profile: req.user,
        state,
        linkProvider: linkFacebookProvider,
        res,
      });
    }
    return await completeSocialLogin({
      provider: 'facebook',
      profile: req.user,
      upsertUser: upsertFacebookUser,
      res,
    });
  } catch (error) {
    console.error('Facebook OAuth callback failed:', error?.message || 'unknown error');
    return res.redirect(loginRedirect('server_error'));
  }
};

const handleGoogleLinkState = issueLinkState('google');
const handleFacebookLinkState = issueLinkState('facebook');
const handleGoogleLinkInitiate = initiateLink('google');
const handleFacebookLinkInitiate = initiateLink('facebook');

export {
  authenticateOAuthCallback,
  beginOAuth,
  handleFacebookCallback,
  handleFacebookLinkInitiate,
  handleFacebookLinkState,
  handleGoogleCallback,
  handleGoogleLinkInitiate,
  handleGoogleLinkState,
  requireOAuthProvider,
};
