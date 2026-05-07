import {
  upsertGoogleUser,
  upsertFacebookUser,
} from "../services/SocialAuth.service.js";
import dotenv from "dotenv";

dotenv.config();

const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

const handleGoogleCallback = async (req, res) => {
  try {
    // req.user is data returned from Passport's Google Strategy
    const googleProfile = req.user;

    if (!googleProfile) {
      return res
        .status(401)
        .json({ EM: "Google authentication failed", EC: 401 });
    }

    const data = await upsertGoogleUser(googleProfile);

    if (data.EC === 0) {
      res.cookie("refreshToken", data.DT.refresh_token, {
        httpOnly: true,
        secure: false,
        sameSite: "strict",
        maxAge: process.env.COOKIE_REFRESH_MAX_AGE || 604800000,
      });

      delete data.DT.refresh_token;

      return res.redirect(
        `${frontendUrl}/social-callback?token=${data.DT.access_token}`,
      );
    } else {
      return res.redirect(`${frontendUrl}/login?error=social_auth_failed`);
    }
  } catch (error) {
    console.log("Error in handleGoogleCallback controller: ", error);
    return res.redirect(`${frontendUrl}/login?error=server_error`);
  }
};

const handleFacebookCallback = async (req, res) => {
  try {
    if (!req.user) {
      return res.redirect(`${frontendUrl}/login?error=facebook_auth_failed`);
    }

    const data = await upsertFacebookUser(req.user);

    if (data.EC === 0) {
      res.cookie("refreshToken", data.DT.refresh_token, {
        httpOnly: true,
        secure: false,
        sameSite: "strict",
        maxAge: process.env.COOKIE_REFRESH_MAX_AGE || 604800000,
      });

      delete data.DT.refresh_token;

      return res.redirect(
        `${frontendUrl}/social-callback?token=${data.DT.access_token}`,
      );
    }

    return res.redirect(`${frontendUrl}/login?error=facebook_auth_failed`);
  } catch (error) {
    console.log("Error FB Controller: ", error);
    return res.redirect(`${frontendUrl}/login?error=server_error`);
  }
};

export { handleGoogleCallback, handleFacebookCallback };
