import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import dotenv from "dotenv";
import { Strategy as FacebookStrategy } from "passport-facebook"; 

dotenv.config();

const PROVIDER_VARIABLES = Object.freeze({
  google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'],
  facebook: ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET', 'FACEBOOK_REDIRECT_URI'],
});

const getMissingOAuthProviderVariables = (provider) => {
  const names = PROVIDER_VARIABLES[provider] || [];
  return names.filter((name) => !String(process.env[name] || '').trim());
};

const isOAuthProviderConfigured = (provider) => (
  Object.hasOwn(PROVIDER_VARIABLES, provider)
  && getMissingOAuthProviderVariables(provider).length === 0
);

const profileVerifier = async (_accessToken, _refreshToken, profile, done) => {
  try {
    return done(null, profile);
  } catch (error) {
    return done(error, null);
  }
};

if (isOAuthProviderConfigured('google')) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_REDIRECT_URI,
      },
      profileVerifier,
    ),
  );
}

if (isOAuthProviderConfigured('facebook')) {
  passport.use(
    new FacebookStrategy(
      {
        clientID: process.env.FACEBOOK_APP_ID,
        clientSecret: process.env.FACEBOOK_APP_SECRET,
        callbackURL: process.env.FACEBOOK_REDIRECT_URI,
        profileFields: ['id', 'displayName', 'photos', 'email'],
      },
      profileVerifier,
    ),
  );
}

export default passport;
export {
  getMissingOAuthProviderVariables,
  isOAuthProviderConfigured,
};
