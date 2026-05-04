import bcrypt from "bcryptjs";
import { Op } from "sequelize";
import db from "../../../core/database/connection.js";
import User from "../models/User.model.js";
import AuthProvider from "../models/AuthProvider.model.js";
import RefreshToken from "../models/RefreshToken.model.js";
import { createAccessToken, createRefreshToken, verifyToken } from "../../../core/utils/jwt.util.js";

const hashUserPassword = async (userPassword) => {
  const salt = await bcrypt.genSalt(10);
  return await bcrypt.hash(userPassword, salt);
};

const checkExistingData = async (email, phone) => {
  const orConditions = [];
  if (email) orConditions.push({ email: email });
  if (phone) orConditions.push({ phone_number: phone });

  if (orConditions.length === 0) return null;

  let user = await User.findOne({
    where: { [Op.or]: orConditions },
  });

  if (user) {
    if (user.email === email) return "email";
    if (user.phone_number === phone) return "phone number";
  }
  return null;
};

const handleRegisterUser = async (rawUserData) => {
  // Open a transaction to ensure data integrity
  const trans = await db.transaction();
  try {
    const isExistData = await checkExistingData(
      rawUserData.email,
      rawUserData.phone_number,
    );

    if (isExistData) {
      await trans.rollback(); // Rollback transaction if data already exists
      return {
        EM: `This ${isExistData} is already exist.`,
        EC: 409,
        DT: "",
      };
    }

    const newUser = await User.create(
      {
        email: rawUserData.email,
        phone_number: rawUserData.phone_number || null,
        full_name: rawUserData.full_name,
        role: "CUSTOMER", 
      },
      { transaction: trans },
    );

    let hashPassword = await hashUserPassword(rawUserData.password);

    await AuthProvider.create(
      {
        user_id: newUser.id, 
        provider: "LOCAL",
        password_hash: hashPassword,
      },
      { transaction: trans },
    );

    await trans.commit();

    return {
      EM: "User account is created successfully.",
      EC: 0,
      DT: "",
    };
  } catch (error) {
    await trans.rollback();
    console.log("Something wrongs in handleRegisterUser: ", error);
    return {
      EM: "Something wrongs in service...",
      EC: 500,
      DT: "",
    };
  }
};

const checkPassword = async (inputPassword, hashPassword) => {
  return await bcrypt.compare(inputPassword, hashPassword);
};

const handleLoginUser = async (inputUserData) => {
  try {
    let user = await User.findOne({
      where: {
        [Op.or]: [
          { email: inputUserData.valueLogin },
          { phone_number: inputUserData.valueLogin },
        ],
      },
    });

    if (!user) {
      return { 
        EM: "Your email/phone number or password is incorrect.", 
        EC: 401, 
        DT: "" 
      };
    }

    // Check active status account 
    if (!user.is_active) {
      return { 
        EM: "Your account has been locked by Administrator.", 
        EC: 403, 
        DT: "" 
      };
    }

    // Find AuthProvider record for this user with provider 'LOCAL'
    let authProvider = await AuthProvider.findOne({
      where: {
        user_id: user.id,
        provider: 'LOCAL'
      }
    });

    if (!authProvider || !authProvider.password_hash) {
      return { 
        EM: "Please login with your Social Account (Google/Facebook).", 
        EC: 400, 
        DT: "" 
      };
    }

    let isCorrectPassword = await checkPassword(inputUserData.password, authProvider.password_hash);

    if (!isCorrectPassword) {
      return { 
        EM: "Your email/phone number or password is incorrect.", 
        EC: 401, 
        DT: "" 
      };
    }

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

    await RefreshToken.create({
      user_id: user.id,
      token: refreshToken,
      expires_at: expiresAt,
      is_revoked: false
    });

    // plain: true to get raw user data without metadata, timestamps, etc.
    const userData = user.get({ plain: true });

    return {
      EM: "Login successfully.",
      EC: 0,
      DT: {
        access_token: accessToken,
        refresh_token: refreshToken, 
        user: userData
      },
    };
  } catch (error) {
    console.log("Error in handleLoginUser: ", error);
    return {
      EM: "Something wrongs in service...",
      EC: 500,
      DT: "",
    };
  }
};

const handleRefreshToken = async (cookieToken) => {
  try {
    //verify refresh token sent from client (in cookie)
    const verification = verifyToken(cookieToken, true); 
    if (!verification.isValid) {
      return { 
        EM: "Invalid or expired refresh token. Please login again.", 
        EC: 401, 
        DT: "" 
      };
    }

    const decodedUser = verification.decoded;

    const existingToken = await RefreshToken.findOne({ where: { token: cookieToken } });

    if (!existingToken) {
      return { 
        EM: "Token not found in system.", 
        EC: 401,
        DT: "" 
        };
    }

    // Validate token if it's already revoked
    if (existingToken.is_revoked) {
      await RefreshToken.update(
        { is_revoked: true }, // Revoke all tokens of this user
        { where: { user_id: decodedUser.id } }
      );
      return { 
        EM: "Security Alert: Token reuse detected. All sessions revoked. Please login again.", 
        EC: 403, 
        DT: "" 
      };
    }

    // Revoke current token to prevent reuse
    await existingToken.update({ is_revoked: true });

    let user = await User.findOne({ where: { id: decodedUser.id } });
    if (!user || !user.is_active) {
      return { EM: "User not found or account is locked.", EC: 401, DT: "" };
    }

    const payload = {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
    };

    const newAccessToken = createAccessToken(payload);
    const newRefreshToken = createRefreshToken(payload);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await RefreshToken.create({
      user_id: user.id,
      token: newRefreshToken,
      expires_at: expiresAt,
      is_revoked: false
    });

    return {
      EM: "Refresh token successfully.",
      EC: 0,
      DT: {
        access_token: newAccessToken,
        refresh_token: newRefreshToken 
      },
    };
  } catch (error) {
    console.log("Error in handleRefreshToken: ", error);
    return { EM: "Something wrongs in service...", EC: 500, DT: "" };
  }
};

const handleLogout = async (cookieToken) => {
  try {
    if (cookieToken) {
      await RefreshToken.update(
        { is_revoked: true },
        { where: { token: cookieToken } }
      );
    }
    return { 
      EM: "Logout successfully.", 
      EC: 0, 
      DT: "" 
    };
  } catch (error) {
    console.log("Error in handleLogout: ", error);
    return { EM: "Something wrongs in service...", EC: 500, DT: "" };
  }
};

export { handleRegisterUser, handleLoginUser, handleRefreshToken, handleLogout };
