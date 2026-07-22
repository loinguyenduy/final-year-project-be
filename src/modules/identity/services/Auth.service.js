import bcrypt from "bcryptjs";
import { Op } from "sequelize";
import db from "../../../core/database/connection.js";
import User from "../models/User.model.js";
import AuthProvider from "../models/AuthProvider.model.js";
import RefreshToken from "../models/RefreshToken.model.js";
import { createAccessToken, createRefreshToken, verifyToken } from "../../../core/utils/jwt.util.js";
import crypto from "crypto"; 
import VerificationToken from "../models/VerificationToken.model.js"; 
import { sendVerificationEmail } from "../../../core/utils/mail.util.js";
import { initializeUserWallets } from '../../fintech/services/Wallet.service.js';
import HandymanProfile from "../models/HandymanProfile.model.js";
import { getCanonicalProfile } from './ParticipantRead.service.js';
import { getRefreshCookieOptions } from '../utils/authCookie.util.js';
import { createAdminAuditLog } from '../../admin/services/AdminAudit.service.js';
import { ADMIN_AUDIT_ACTIONS, ADMIN_AUDIT_TARGETS } from '../../admin/constants/admin.constants.js';

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

    const userRole = rawUserData.role || "CUSTOMER";

    const newUser = await User.create(
      {
        email: rawUserData.email,
        phone_number: rawUserData.phone_number || null,
        full_name: rawUserData.full_name,
        role: userRole,
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

    if (userRole === "HANDYMAN") {
        await HandymanProfile.create({
            user_id: newUser.id, 
            kyc_status: 'UNVERIFIED',
            bayesian_score: 5.00,
            total_jobs_completed: 0,
            security_bond_status: 'UNPAID'
        }, { transaction: trans });
    }

    // create verification token and send email
    const randomToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // expires in 15 minutes

    await VerificationToken.create(
      {
        user_id: newUser.id,
        token: randomToken,
        expires_at: expiresAt,
      },
      { transaction: trans },
    );

    // save all data to database and commit transaction
    await trans.commit();
    sendVerificationEmail(newUser.email, newUser.full_name, randomToken);

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

////////////////////
const checkPassword = async (inputPassword, hashPassword) => {
  return await bcrypt.compare(inputPassword, hashPassword);
};

const buildSessionPayload = (user) => ({
  id: user.id,
  email: user.email,
  full_name: user.full_name,
  role: user.role,
  auth_version: Number(user.auth_version || 0),
});

const issueSession = async (user, auditContext = null) => {
  const transaction = await db.transaction();
  try {
    const canonicalUser = await User.findByPk(user.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!canonicalUser || canonicalUser.role !== user.role || Number(canonicalUser.auth_version || 0) !== Number(user.auth_version || 0)) {
      const error = new Error('The account changed while the session was being created.');
      error.authResult = { EM: 'This session request is no longer valid. Please login again.', EC: 401, code: 'SESSION_REVOKED', DT: '' };
      throw error;
    }
    if (!canonicalUser.is_active) {
      const error = new Error('The account was deactivated while the session was being created.');
      error.authResult = {
        EM: canonicalUser.role === 'ADMIN' ? 'This administrator account is inactive.' : 'Your account is inactive.',
        EC: 403,
        code: canonicalUser.role === 'ADMIN' ? 'ADMIN_NOT_ACTIVE' : 'ACCOUNT_INACTIVE',
        DT: ''
      };
      throw error;
    }
    const payload = buildSessionPayload(canonicalUser);
    const accessToken = createAccessToken(payload);
    const refreshToken = createRefreshToken(payload);
    const expiresAt = new Date(Date.now() + getRefreshCookieOptions().maxAge);

    await RefreshToken.create({
      user_id: user.id,
      token: refreshToken,
      expires_at: expiresAt,
      is_revoked: false
    }, { transaction });

    if (user.role === 'ADMIN' && auditContext) {
      await createAdminAuditLog({
        adminId: user.id,
        action: ADMIN_AUDIT_ACTIONS.LOGIN_SUCCEEDED,
        targetType: ADMIN_AUDIT_TARGETS.SESSION,
        targetId: user.id,
        beforeState: { session_state: 'SIGNED_OUT' },
        afterState: { session_state: 'AUTHENTICATED', role: user.role },
        correlationId: auditContext.correlationId,
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
        transaction
      });
    }

    await transaction.commit();
    return { accessToken, refreshToken };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
};

const handleLoginUser = async (inputUserData, options = {}) => {
  try {
    const isAdminLogin = options.expectedRole === 'ADMIN';
    let user = await User.findOne({
      where: {
        [Op.or]: [
          { email: inputUserData.valueLogin },
          { phone_number: inputUserData.valueLogin },
        ],
      },
      attributes: ['id', 'full_name', 'email', 'phone_number', 'role', 'is_active', 'is_email_verified', 'kyc_status', 'avatar_url', 'auth_version', 'createdAt']
    });

    if (!user) {
      return { 
        EM: isAdminLogin ? 'Invalid administrator credentials.' : "Your email/phone number or password is incorrect.",
        EC: 401,
        code: isAdminLogin ? 'ADMIN_LOGIN_INVALID' : 'LOGIN_INVALID',
        DT: "" 
      };
    }

    let authProvider = await AuthProvider.findOne({
      where: {
        user_id: user.id,
        provider: 'LOCAL'
      }
    });
  
    if (!authProvider || !authProvider.password_hash) {
      return { 
        EM: isAdminLogin ? 'Invalid administrator credentials.' : "Please login with your Social Account (Google/Facebook).",
        EC: isAdminLogin ? 401 : 400,
        code: isAdminLogin ? 'ADMIN_LOGIN_INVALID' : 'LOCAL_LOGIN_UNAVAILABLE',
        DT: "" 
      };
    }

    let isCorrectPassword = await checkPassword(inputUserData.password, authProvider.password_hash);

    if (!isCorrectPassword) {
      return { 
        EM: isAdminLogin ? 'Invalid administrator credentials.' : "Your email/phone number or password is incorrect.",
        EC: 401,
        code: isAdminLogin ? 'ADMIN_LOGIN_INVALID' : 'LOGIN_INVALID',
        DT: "" 
      };
    }

    if (isAdminLogin && user.role !== 'ADMIN') {
      return {
        EM: 'Invalid administrator credentials.',
        EC: 401,
        code: 'ADMIN_LOGIN_INVALID',
        DT: ''
      };
    }
    if (!isAdminLogin && user.role === 'ADMIN') {
      return {
        EM: 'Administrators must sign in through the Admin Portal.',
        EC: 403,
        code: 'ADMIN_PORTAL_REQUIRED',
        DT: ''
      };
    }
    if (!user.is_active) {
      return {
        EM: isAdminLogin ? 'This administrator account is inactive.' : 'Your account has been locked by Administrator.',
        EC: 403,
        code: isAdminLogin ? 'ADMIN_NOT_ACTIVE' : 'ACCOUNT_INACTIVE',
        DT: ''
      };
    }
    if (!user.is_email_verified) {
      return {
        EM: 'Please verify your email address to log in. Check your inbox.',
        EC: 403,
        code: 'EMAIL_VERIFICATION_REQUIRED',
        DT: ''
      };
    }

    const session = await issueSession(user, isAdminLogin ? options.auditContext : null);

    const userData = isAdminLogin
      ? {
        id: user.id, full_name: user.full_name, email: user.email,
        phone_number: user.phone_number || null, role: user.role,
        avatar_url: user.avatar_url || null, is_email_verified: Boolean(user.is_email_verified),
        kyc_status: user.kyc_status, is_active: Boolean(user.is_active), created_at: user.createdAt
      }
      : await getCanonicalProfile(user.id);

    return {
      EM: "Login successfully.",
      EC: 0,
      code: isAdminLogin ? 'ADMIN_LOGIN_SUCCEEDED' : 'LOGIN_SUCCEEDED',
      DT: {
        access_token: session.accessToken,
        refresh_token: session.refreshToken,
        user: userData
      },
    };
  } catch (error) {
    if (error.authResult) return error.authResult;
    console.log("Error in handleLoginUser: ", error);
    return {
      EM: "Something wrongs in service...",
      EC: 500,
      DT: "",
    };
  }
};

const handleRefreshToken = async (cookieToken) => {
  const transaction = await db.transaction();
  try {
    //verify refresh token sent from client (in cookie)
    const verification = verifyToken(cookieToken, true); 
    if (!verification.isValid) {
      await transaction.rollback();
      return { 
        EM: "Invalid or expired refresh token. Please login again.", 
        EC: 401,
        code: 'SESSION_EXPIRED',
        DT: "" 
      };
    }

    const decodedUser = verification.decoded;

    const existingToken = await RefreshToken.findOne({
      where: { token: cookieToken },
      transaction,
      lock: transaction.LOCK.UPDATE
    });

    if (!existingToken) {
      await transaction.rollback();
      return { 
        EM: "Token not found in system.", 
        EC: 401,
        code: decodedUser.role === 'ADMIN' ? 'ADMIN_SESSION_EXPIRED' : 'SESSION_EXPIRED',
        DT: "" 
        };
    }

    const user = await User.findOne({
      where: { id: decodedUser.id },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!user) {
      await existingToken.update({ is_revoked: true }, { transaction });
      await transaction.commit();
      return { EM: 'User not found.', EC: 401, code: 'SESSION_REVOKED', DT: '' };
    }
    if (!user.is_active) {
      await RefreshToken.update({ is_revoked: true }, { where: { user_id: user.id }, transaction });
      await transaction.commit();
      return {
        EM: user.role === 'ADMIN' ? 'This administrator account is inactive.' : 'User account is inactive.',
        EC: user.role === 'ADMIN' ? 403 : 401,
        code: user.role === 'ADMIN' ? 'ADMIN_NOT_ACTIVE' : 'ACCOUNT_INACTIVE',
        DT: ''
      };
    }
    const tokenAuthVersion = Number.isInteger(decodedUser.auth_version) ? decodedUser.auth_version : 0;
    if (decodedUser.role !== user.role || tokenAuthVersion !== Number(user.auth_version || 0)) {
      await RefreshToken.update({ is_revoked: true }, { where: { user_id: user.id }, transaction });
      await transaction.commit();
      return { EM: 'This session has been revoked. Please login again.', EC: 401, code: 'SESSION_REVOKED', DT: '' };
    }

    if (new Date(existingToken.expires_at).getTime() <= Date.now()) {
      await existingToken.update({ is_revoked: true }, { transaction });
      await transaction.commit();
      return {
        EM: 'Refresh token has expired. Please login again.',
        EC: 401,
        code: decodedUser.role === 'ADMIN' ? 'ADMIN_SESSION_EXPIRED' : 'SESSION_EXPIRED',
        DT: ''
      };
    }

    // Validate token if it's already revoked
    if (existingToken.is_revoked) {
      await RefreshToken.update(
        { is_revoked: true },
        { where: { user_id: decodedUser.id }, transaction }
      );
      await transaction.commit();
      return { 
        EM: "Security Alert: Token reuse detected. All sessions revoked. Please login again.", 
        EC: 403,
        code: decodedUser.role === 'ADMIN' ? 'ADMIN_SESSION_EXPIRED' : 'SESSION_EXPIRED',
        DT: "" 
      };
    }

    // Revoke current token to prevent reuse
    await existingToken.update({ is_revoked: true }, { transaction });

    const payload = buildSessionPayload(user);

    const newAccessToken = createAccessToken(payload);
    const newRefreshToken = createRefreshToken(payload);

    const expiresAt = new Date(Date.now() + getRefreshCookieOptions().maxAge);

    await RefreshToken.create({
      user_id: user.id,
      token: newRefreshToken,
      expires_at: expiresAt,
      is_revoked: false
    }, { transaction });

    await transaction.commit();

    return {
      EM: "Refresh token successfully.",
      EC: 0,
      code: 'SESSION_REFRESHED',
      DT: {
        access_token: newAccessToken,
        refresh_token: newRefreshToken,
        user: {
          id: user.id,
          email: user.email,
          full_name: user.full_name,
          role: user.role
        }
      },
    };
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    console.log("Error in handleRefreshToken: ", error);
    return { EM: "Something wrongs in service...", EC: 500, DT: "" };
  }
};

const handleLogout = async (cookieToken, auditContext = null) => {
  const transaction = await db.transaction();
  try {
    if (cookieToken) {
      const refreshToken = await RefreshToken.findOne({
        where: { token: cookieToken },
        transaction,
        lock: transaction.LOCK.UPDATE
      });
      if (refreshToken && !refreshToken.is_revoked) {
        const wasActive = new Date(refreshToken.expires_at).getTime() > Date.now();
        await refreshToken.update({ is_revoked: true }, { transaction });
        const user = await User.findByPk(refreshToken.user_id, { transaction });
        if (wasActive && user?.role === 'ADMIN') {
          await createAdminAuditLog({
            adminId: user.id,
            action: ADMIN_AUDIT_ACTIONS.LOGOUT,
            targetType: ADMIN_AUDIT_TARGETS.SESSION,
            targetId: user.id,
            beforeState: { session_state: 'AUTHENTICATED', role: user.role },
            afterState: { session_state: 'SIGNED_OUT' },
            correlationId: auditContext?.correlationId,
            ipAddress: auditContext?.ipAddress,
            userAgent: auditContext?.userAgent,
            transaction
          });
        }
      }
    }
    await transaction.commit();
    return { 
      EM: "Logout successfully.", 
      EC: 0, 
      code: 'LOGOUT_COMPLETED',
      DT: "" 
    };
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    console.log("Error in handleLogout: ", error);
    return { EM: "Something wrongs in service...", EC: 500, DT: "" };
  }
};

const handleVerifyEmail = async (token) => {
  const trans = await db.transaction();
  try {
    //Find the verification token record
    const verificationRecord = await VerificationToken.findOne({ where: { token: token } });

    if (!verificationRecord) {
      await trans.rollback();
      return { 
        EM: "Invalid or expired verification token.", 
        EC: 400 
      };
    }

    // Check if token is expired
    if (new Date() > verificationRecord.expires_at) {
      await trans.rollback();
      return { 
        EM: "Verification token has expired. Please request a new one.", 
        EC: 400 
      };
    }

    const user = await User.findOne({ 
      where: { id: verificationRecord.user_id },
      transaction: trans
    });

    if (!user) {
      await trans.rollback();
      return { 
        EM: "User not found.", 
        EC: 404,
        DT: "" 
      };
    }

    // Update user's email verification status
    await User.update(
      { is_email_verified: true },
      { where: { id: verificationRecord.user_id }, transaction: trans }
    );

    // Initialize wallets for the user after email verification
    await initializeUserWallets(user.id, user.role, trans);

    if (user.role === 'HANDYMAN') {
        await HandymanProfile.update(
            { handyman_level: 'C1' },
            { where: { user_id: user.id }, transaction: trans }
        );
    }

    // Delete the verification token after successful verification
    await verificationRecord.destroy({ transaction: trans });

    await trans.commit();
    return { 
      EM: "Email verified successfully. You can now login.", 
      EC: 0 
    };
  } catch (error) {
    await trans.rollback();
    console.log("Error in handleVerifyEmail: ", error);
    return { 
      EM: "Server error during verification.", 
      EC: 500 
    };
  }
};

const handleResendVerifyEmail = async (email) => {
  const t = await db.transaction();
  try {
    const user = await User.findOne({ where: { email: email } });

    if (!user) {
      await t.rollback();
      return { 
        EM: "User not found.", 
        EC: 404
      };
    }

    if (user.is_email_verified) {
      await t.rollback();
      return { 
        EM: "Email is already verified. You can log in.", 
        EC: 400 
      };
    }

    await VerificationToken.destroy({
      where: { user_id: user.id },
      transaction: t,
    });

    const randomToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); 

    await VerificationToken.create(
      {
        user_id: user.id,
        token: randomToken,
        expires_at: expiresAt,
      },
      { transaction: t }
    );

    await t.commit();

    sendVerificationEmail(user.email, user.full_name, randomToken);

    return { 
      EM: "A new verification email has been sent.", 
      EC: 0 
    };
  } catch (error) {
    await t.rollback();
    console.log("Error in handleResendVerifyEmail: ", error);
    return { 
      EM: "Server error.", 
      EC: 500 
    };
  }
};


export { checkPassword, hashUserPassword, handleRegisterUser, handleLoginUser, handleRefreshToken, handleLogout, handleVerifyEmail, handleResendVerifyEmail };
