import db from "../../../core/database/connection.js";
import User from "../models/User.model.js";
import AuthProvider from "../models/AuthProvider.model.js";
import RefreshToken from "../models/RefreshToken.model.js";
import { createAccessToken, createRefreshToken } from "../../../core/utils/jwt.util.js";

const upsertGoogleUser = async (googleProfile) => {
  const t = await db.transaction();
  try {
    // Trích xuất dữ liệu từ Google Profile
    const email = googleProfile.emails[0].value;
    const fullName = googleProfile.displayName;
    const avatarUrl = googleProfile.photos[0].value;
    const providerId = googleProfile.id;

    // 1. Tìm User bằng Email
    let user = await User.findOne({ where: { email: email } });

    if (!user) {
      // TRƯỜNG HỢP 1: User hoàn toàn mới -> TẠO MỚI
      user = await User.create(
        {
          email: email,
          full_name: fullName,
          avatar_url: avatarUrl,
          role: "CUSTOMER",
          is_email_verified: true, // Google đã xác thực email
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
    } else {
      // TRƯỜNG HỢP 2: User đã tồn tại -> ACCOUNT LINKING
      // Cập nhật is_email_verified thành true (nếu trước đó đăng ký local mà chưa verify)
      if (!user.is_email_verified) {
        await user.update({ is_email_verified: true }, { transaction: t });
      }

      // Kiểm tra xem đã link với Google chưa
      const existingProvider = await AuthProvider.findOne({
        where: { user_id: user.id, provider: "GOOGLE" },
      });

      if (!existingProvider) {
        // Chưa có thì tạo liên kết (Linking)
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

    // 2. Sinh Token của hệ thống (Access & Refresh Token)
    const payload = {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
    };

    const accessToken = createAccessToken(payload);
    const refreshToken = createRefreshToken(payload);

    // 3. Lưu Refresh Token vào Database (Cơ chế RTR)
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
    // CHỐT CHẶN BẢO MẬT: Bắt buộc phải có email
    if (!facebookProfile.emails || facebookProfile.emails.length === 0) {
      await t.rollback();
      return { 
        EM: "Facebook email is required to login.", 
        EC: 400, 
        DT: "" 
      };
    }

    // LẤY DỮ LIỆU
    const email = facebookProfile.emails[0].value;
    const fullName = facebookProfile.displayName;
    const avatarUrl = facebookProfile.photos && facebookProfile.photos.length > 0 ? facebookProfile.photos[0].value : null;
    const providerId = facebookProfile.id;

    // TÌM & ĐỒNG BỘ USER (ACCOUNT LINKING)
    let user = await User.findOne({ where: { email: email } });

    if (!user) {
      user = await User.create(
        { 
          email: email, 
          full_name: fullName, 
          avatar_url: avatarUrl, 
          role: "CUSTOMER", 
          is_email_verified: true // FB đã xác thực
        },
        { transaction: t }
      );

      await AuthProvider.create(
        { user_id: user.id, provider: "FACEBOOK", provider_id: providerId },
        { transaction: t }
      );
    } else {
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

    // SINH TOKEN
    const payload = { id: user.id, email: user.email, full_name: user.full_name, role: user.role };
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