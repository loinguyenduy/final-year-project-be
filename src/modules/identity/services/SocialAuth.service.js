import db from "../../../core/database/connection.js";
import User from "../models/User.model.js";
import AuthProvider from "../models/AuthProvider.model.js";
import RefreshToken from "../models/RefreshToken.model.js";
import { createAccessToken, createRefreshToken } from "../../../core/utils/jwt.util.js";
import { initializeUserWallets } from '../../fintech/services/Wallet.service.js';
import { getCanonicalProfile } from './ParticipantRead.service.js';
import { getRefreshCookieOptions } from '../utils/authCookie.util.js';
import { isOAuthLinkAuthVersionCurrent } from './OAuthLinkState.service.js';

const upsertGoogleUser = async (googleProfile) => {
  const t = await db.transaction();
  try {
    // Get user info from Google profile
    const email = googleProfile.emails[0].value;
    const fullName = googleProfile.displayName;
    const avatarUrl = googleProfile.photos[0].value;
    const providerId = googleProfile.id;

    let user = await User.findOne({ where: { email: email }, transaction: t, lock: t.LOCK.UPDATE });

    if (user?.role === 'ADMIN') {
      await t.rollback();
      return {
        EM: 'Administrators must sign in through the Admin Portal.',
        EC: 403,
        code: 'ADMIN_PORTAL_REQUIRED',
        DT: ''
      };
    }
    if (user && !user.is_active) {
      await t.rollback();
      return { EM: 'User account is inactive.', EC: 403, code: 'ACCOUNT_INACTIVE', DT: '' };
    }

    if (!user) {
      // case 1: if user does not exist, create new user and link to Google
      user = await User.create(
        {
          email: email,
          full_name: fullName,
          avatar_url: avatarUrl,
          role: "CUSTOMER",
          is_email_verified: true, 
        },
        { transaction: t }
      );

      await AuthProvider.create(
        {
          user_id: user.id,
          provider: "GOOGLE",
          provider_id: providerId,
        },
        { transaction: t }
      );

      // Initialize wallets for the new user
      await initializeUserWallets(user.id, user.role, t);
    } else {
      // case 2: if user exists, check if email is verified and link to Google if not linked yet
      if (!user.is_email_verified) {
        await user.update({ is_email_verified: true }, { transaction: t });
      }

      const existingProvider = await AuthProvider.findOne({
        where: { user_id: user.id, provider: "GOOGLE" },
        transaction: t,
        lock: t.LOCK.UPDATE
      });

      if (!existingProvider) {
        await AuthProvider.create(
          {
            user_id: user.id,
            provider: "GOOGLE",
            provider_id: providerId,
          },
          { transaction: t }
        );
      }
    }

    // create JWT tokens
    const payload = {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      auth_version: Number(user.auth_version || 0),
    };

    const accessToken = createAccessToken(payload);
    const refreshToken = createRefreshToken(payload);

    const expiresAt = new Date(Date.now() + getRefreshCookieOptions().maxAge);

    await RefreshToken.create(
      {
        user_id: user.id,
        token: refreshToken,
        expires_at: expiresAt,
        is_revoked: false,
      },
      { transaction: t }
    );

    await t.commit();

    return {
      EM: "Google login successfully",
      EC: 0,
      DT: {
        access_token: accessToken,
        refresh_token: refreshToken,
        user: await getCanonicalProfile(user.id),
      },
    };
  } catch (error) {
    await t.rollback();
    console.log("Error in upsertGoogleUser: ", error);
    return { EM: "Something went wrong with Google Login", EC: 500, DT: "" };
  }
};

const upsertFacebookUser = async (facebookProfile) => {
  const t = await db.transaction();
  try {
    if (!facebookProfile.emails || facebookProfile.emails.length === 0) {
      await t.rollback();
      return { 
        EM: "Facebook email is required to login.", 
        EC: 400, 
        DT: "" 
      };
    }

    // Get user info from Facebook profile
    const email = facebookProfile.emails[0].value;
    const fullName = facebookProfile.displayName;
    const avatarUrl = facebookProfile.photos && facebookProfile.photos.length > 0 ? facebookProfile.photos[0].value : null;
    const providerId = facebookProfile.id;

    let user = await User.findOne({ where: { email: email }, transaction: t, lock: t.LOCK.UPDATE });

    if (user?.role === 'ADMIN') {
      await t.rollback();
      return {
        EM: 'Administrators must sign in through the Admin Portal.',
        EC: 403,
        code: 'ADMIN_PORTAL_REQUIRED',
        DT: ''
      };
    }
    if (user && !user.is_active) {
      await t.rollback();
      return { EM: 'User account is inactive.', EC: 403, code: 'ACCOUNT_INACTIVE', DT: '' };
    }

    //case 1: if user does not exist, create new user and link to Facebook
    if (!user) {
      user = await User.create(
        { 
          email: email, 
          full_name: fullName, 
          avatar_url: avatarUrl, 
          role: "CUSTOMER", 
          is_email_verified: true 
        },
        { transaction: t }
      );

      await AuthProvider.create(
        { user_id: user.id, provider: "FACEBOOK", provider_id: providerId },
        { transaction: t }
      );

      // Initialize wallets for the new user
      await initializeUserWallets(user.id, user.role, t);
    } else {
      // case 2: if user exists, check if email is verified and link to Facebook if not linked yet
      if (!user.is_email_verified) {
        await user.update({ is_email_verified: true }, { transaction: t });
      }

      const existingProvider = await AuthProvider.findOne({
        where: { user_id: user.id, provider: "FACEBOOK" },
        transaction: t,
        lock: t.LOCK.UPDATE
      });

      if (!existingProvider) {
        await AuthProvider.create(
          { user_id: user.id, provider: "FACEBOOK", provider_id: providerId },
          { transaction: t }
        );
      }
    }

    const payload = { 
      id: user.id, 
      email: user.email, 
      full_name: user.full_name, 
      role: user.role,
      auth_version: Number(user.auth_version || 0)
    };
    const accessToken = createAccessToken(payload);
    const refreshToken = createRefreshToken(payload);

    const expiresAt = new Date(Date.now() + getRefreshCookieOptions().maxAge);

    await RefreshToken.create(
      { user_id: user.id, token: refreshToken, expires_at: expiresAt, is_revoked: false },
      { transaction: t }
    );

    await t.commit();

    return {
      EM: "Facebook login successfully",
      EC: 0,
      DT: { access_token: accessToken, refresh_token: refreshToken, user: await getCanonicalProfile(user.id) },
    };
  } catch (error) {
    await t.rollback();
    console.log("Error in upsertFacebookUser: ", error);
    return { EM: "Server error during Facebook login", EC: 500, DT: "" };
  }
};

// ─── ACCOUNT LINKING ─────────────────────────────────────────────────────────
// Link an existing account to a Google or Facebook provider.
// Called after the OAuth flow when the user is already logged in.

const linkGoogleProvider = async (userId, googleProfile, { expectedAuthVersion } = {}) => {
    try {
        const user = await User.findByPk(userId, { attributes: ['id', 'role', 'is_active', 'auth_version'] });
        if (!user || !user.is_active) return { EM: 'User account is unavailable.', EC: 403, code: 'ACCOUNT_INACTIVE', DT: '' };
        if (user.role === 'ADMIN') return { EM: 'Administrators cannot link social login providers.', EC: 403, code: 'ADMIN_PORTAL_REQUIRED', DT: '' };
        if (!isOAuthLinkAuthVersionCurrent(expectedAuthVersion, Number(user.auth_version || 0))) {
            return { EM: 'This session is no longer valid.', EC: 401, code: 'SESSION_REVOKED', DT: '' };
        }
        const providerId = googleProfile.id;

        const alreadyLinkedToMe = await AuthProvider.findOne({
            where: { user_id: userId, provider: 'GOOGLE' }
        });
        if (alreadyLinkedToMe) {
            return { EM: "Google is already linked to your account.", EC: 400, DT: "" };
        }

        const linkedToOther = await AuthProvider.findOne({
            where: { provider: 'GOOGLE', provider_id: providerId }
        });
        if (linkedToOther) {
            return { EM: "This Google account is already linked to another user.", EC: 400, DT: "" };
        }

        await AuthProvider.create({ user_id: userId, provider: 'GOOGLE', provider_id: providerId });

        return { EM: "Google linked successfully.", EC: 0, DT: "" };
    } catch (error) {
        console.error(">>> Error in linkGoogleProvider: ", error);
        return { EM: "Internal server error while linking Google account.", EC: 500, DT: "" };
    }
};

const linkFacebookProvider = async (userId, facebookProfile, { expectedAuthVersion } = {}) => {
    try {
        const user = await User.findByPk(userId, { attributes: ['id', 'role', 'is_active', 'auth_version'] });
        if (!user || !user.is_active) return { EM: 'User account is unavailable.', EC: 403, code: 'ACCOUNT_INACTIVE', DT: '' };
        if (user.role === 'ADMIN') return { EM: 'Administrators cannot link social login providers.', EC: 403, code: 'ADMIN_PORTAL_REQUIRED', DT: '' };
        if (!isOAuthLinkAuthVersionCurrent(expectedAuthVersion, Number(user.auth_version || 0))) {
            return { EM: 'This session is no longer valid.', EC: 401, code: 'SESSION_REVOKED', DT: '' };
        }
        if (!facebookProfile.emails || facebookProfile.emails.length === 0) {
            return { EM: "Facebook account must have an email to be linked.", EC: 400, DT: "" };
        }

        const providerId = facebookProfile.id;

        const alreadyLinkedToMe = await AuthProvider.findOne({
            where: { user_id: userId, provider: 'FACEBOOK' }
        });
        if (alreadyLinkedToMe) {
            return { EM: "Facebook is already linked to your account.", EC: 400, DT: "" };
        }

        const linkedToOther = await AuthProvider.findOne({
            where: { provider: 'FACEBOOK', provider_id: providerId }
        });
        if (linkedToOther) {
            return { EM: "This Facebook account is already linked to another user.", EC: 400, DT: "" };
        }

        await AuthProvider.create({ user_id: userId, provider: 'FACEBOOK', provider_id: providerId });

        return { EM: "Facebook linked successfully.", EC: 0, DT: "" };
    } catch (error) {
        console.error(">>> Error in linkFacebookProvider: ", error);
        return { EM: "Internal server error while linking Facebook account.", EC: 500, DT: "" };
    }
};

export { upsertGoogleUser, upsertFacebookUser, linkGoogleProvider, linkFacebookProvider };
