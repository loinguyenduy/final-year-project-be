import db from "../../../core/database/connection.js";
import User from "../models/User.model.js";
import AuthProvider from "../models/AuthProvider.model.js";
import RefreshToken from "../models/RefreshToken.model.js";
import { createAccessToken, createRefreshToken } from "../../../core/utils/jwt.util.js";
import { initializeUserWallets } from '../../fintech/services/Wallet.service.js';

const upsertGoogleUser = async (googleProfile) => {
  const t = await db.transaction();
  try {
    // Get user info from Google profile
    const email = googleProfile.emails[0].value;
    const fullName = googleProfile.displayName;
    const avatarUrl = googleProfile.photos[0].value;
    const providerId = googleProfile.id;

    let user = await User.findOne({ where: { email: email } });

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
    };

    const accessToken = createAccessToken(payload);
    const refreshToken = createRefreshToken(payload);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

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
        user: user.get({ plain: true }),
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

    let user = await User.findOne({ where: { email: email } });

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
      role: user.role 
    };
    const accessToken = createAccessToken(payload);
    const refreshToken = createRefreshToken(payload);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await RefreshToken.create(
      { user_id: user.id, token: refreshToken, expires_at: expiresAt, is_revoked: false },
      { transaction: t }
    );

    await t.commit();

    return {
      EM: "Facebook login successfully",
      EC: 0,
      DT: { access_token: accessToken, refresh_token: refreshToken, user: user.get({ plain: true }) },
    };
  } catch (error) {
    await t.rollback();
    console.log("Error in upsertFacebookUser: ", error);
    return { EM: "Server error during Facebook login", EC: 500, DT: "" };
  }
};

export { upsertGoogleUser, upsertFacebookUser };