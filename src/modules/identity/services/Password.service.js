import crypto from 'node:crypto';
import { Op } from 'sequelize';
import db from '../../../core/database/connection.js';
import User from '../models/User.model.js';
import AuthProvider from '../models/AuthProvider.model.js';
import RefreshToken from '../models/RefreshToken.model.js';
import PasswordActionToken from '../models/PasswordActionToken.model.js';
import { hashUserPassword, checkPassword } from './Auth.service.js';
import { disconnectUserSockets } from '../../../core/realtime/realtime.gateway.js';
import { sendPasswordActionEmail, sendPasswordChangedEmail } from '../../../core/utils/mail.util.js';
import {
  PASSWORD_ACTION_PURPOSES,
  PASSWORD_ACTION_RESEND_COOLDOWN_MS,
  PASSWORD_ACTION_TTL_MS,
  validatePassword
} from '../constants/password.constants.js';

class PasswordActionError extends Error {
  constructor(message, status = 400, code = 'VALIDATION_ERROR') {
    super(message);
    this.name = 'PasswordActionError';
    this.status = status;
    this.code = code;
  }
}

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const hashToken = (token) => crypto.createHash('sha256').update(String(token || '')).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');
const genericForgotResult = () => ({
  EM: 'If an eligible account exists, a password reset email has been sent.',
  EC: 0,
  code: 'PASSWORD_RESET_REQUEST_ACCEPTED',
  DT: ''
});

const revokeTokenBestEffort = async (id, context = {}) => {
  try {
    await PasswordActionToken.update(
      { revoked_at: new Date() },
      { where: { id, consumed_at: null, revoked_at: null } }
    );
  } catch (error) {
    console.error('[password-action] Failed to revoke an undelivered token.', {
      correlation_id: context.correlationId || null,
      purpose: context.purpose || null,
      user_id: context.userId || null,
      error: error?.message || 'Unknown error'
    });
  }
};

const issuePasswordAction = async ({ userId, purpose }) => {
  const transaction = await db.transaction();
  try {
    const user = await User.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!user || !user.is_active || !['CUSTOMER', 'HANDYMAN'].includes(user.role)) {
      throw new PasswordActionError('The account is not eligible for this password action.', 403, 'PASSWORD_ACTION_NOT_ALLOWED');
    }
    const localProvider = await AuthProvider.findOne({
      where: { user_id: user.id, provider: 'LOCAL' },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (purpose === PASSWORD_ACTION_PURPOSES.RESET && !localProvider?.password_hash) {
      throw new PasswordActionError('The account does not have a local password.', 409, 'PASSWORD_NOT_SET');
    }
    if (purpose === PASSWORD_ACTION_PURPOSES.SET && localProvider?.password_hash) {
      throw new PasswordActionError('The account already has a local password.', 409, 'PASSWORD_ALREADY_SET');
    }

    const mostRecent = await PasswordActionToken.findOne({
      where: { user_id: user.id, purpose },
      attributes: ['createdAt'],
      order: [['createdAt', 'DESC']],
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (mostRecent && Date.now() - new Date(mostRecent.createdAt).getTime() < PASSWORD_ACTION_RESEND_COOLDOWN_MS) {
      throw new PasswordActionError(
        'Please wait before requesting another password email.',
        429,
        'PASSWORD_ACTION_COOLDOWN'
      );
    }

    await PasswordActionToken.update({ revoked_at: new Date() }, {
      where: {
        user_id: user.id,
        purpose,
        consumed_at: null,
        revoked_at: null,
        expires_at: { [Op.gt]: new Date() }
      },
      transaction
    });

    const rawToken = newToken();
    const record = await PasswordActionToken.create({
      user_id: user.id,
      purpose,
      token_hash: hashToken(rawToken),
      issued_auth_version: Number(user.auth_version || 0),
      expires_at: new Date(Date.now() + PASSWORD_ACTION_TTL_MS)
    }, { transaction });
    await transaction.commit();
    return { user, record, rawToken };
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  }
};

const requestPasswordReset = async ({ email, correlationId }) => {
  const normalized = normalizeEmail(email);
  const user = normalized ? await User.findOne({ where: { email: normalized } }) : null;
  if (!user || !user.is_active || !['CUSTOMER', 'HANDYMAN'].includes(user.role)) return genericForgotResult();
  const localProvider = await AuthProvider.findOne({ where: { user_id: user.id, provider: 'LOCAL' } });
  if (!localProvider?.password_hash) return genericForgotResult();

  let issued;
  try {
    issued = await issuePasswordAction({ userId: user.id, purpose: PASSWORD_ACTION_PURPOSES.RESET });
    await sendPasswordActionEmail({
      toEmail: user.email,
      fullName: user.full_name,
      rawToken: issued.rawToken,
      purpose: PASSWORD_ACTION_PURPOSES.RESET,
      expiresInMinutes: Math.round(PASSWORD_ACTION_TTL_MS / 60000)
    });
  } catch (error) {
    if (issued?.record?.id) {
      await revokeTokenBestEffort(issued.record.id, {
        correlationId,
        purpose: PASSWORD_ACTION_PURPOSES.RESET,
        userId: user.id
      });
    }
    if (!(error instanceof PasswordActionError)) {
      console.error('[password-action] Reset email could not be delivered.', {
        correlation_id: correlationId || null,
        purpose: PASSWORD_ACTION_PURPOSES.RESET,
        user_id: user.id,
        error: error?.message || 'Unknown error'
      });
    }
  }
  return genericForgotResult();
};

const requestSetPassword = async ({ userId, correlationId }) => {
  const issued = await issuePasswordAction({ userId, purpose: PASSWORD_ACTION_PURPOSES.SET });
  try {
    await sendPasswordActionEmail({
      toEmail: issued.user.email,
      fullName: issued.user.full_name,
      rawToken: issued.rawToken,
      purpose: PASSWORD_ACTION_PURPOSES.SET,
      expiresInMinutes: Math.round(PASSWORD_ACTION_TTL_MS / 60000)
    });
  } catch (error) {
    await revokeTokenBestEffort(issued.record.id, {
      correlationId,
      purpose: PASSWORD_ACTION_PURPOSES.SET,
      userId
    });
    throw new PasswordActionError('Unable to send the Set Password email. Please try again.', 503, 'PASSWORD_EMAIL_DELIVERY_FAILED');
  }
  return { EM: 'A Set Password email has been sent.', EC: 0, code: 'SET_PASSWORD_EMAIL_SENT', DT: '' };
};

const loadActionToken = async ({ token, purpose, transaction = null, lock = false }) => {
  if (typeof token !== 'string' || token.length < 32 || token.length > 256) {
    throw new PasswordActionError('The password action link is invalid.', 400, 'PASSWORD_ACTION_TOKEN_INVALID');
  }
  const record = await PasswordActionToken.findOne({
    where: { token_hash: hashToken(token), purpose },
    transaction,
    ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {})
  });
  if (!record || record.revoked_at || record.consumed_at) {
    throw new PasswordActionError('The password action link is invalid or has already been used.', 400, 'PASSWORD_ACTION_TOKEN_INVALID');
  }
  if (new Date(record.expires_at).getTime() <= Date.now()) {
    throw new PasswordActionError('The password action link has expired.', 400, 'PASSWORD_ACTION_TOKEN_EXPIRED');
  }
  return record;
};

const validatePasswordAction = async ({ token, purpose }) => {
  const record = await loadActionToken({ token, purpose });
  const user = await User.findByPk(record.user_id, { attributes: ['id', 'role', 'is_active', 'auth_version'] });
  if (!user || !user.is_active || !['CUSTOMER', 'HANDYMAN'].includes(user.role)
    || Number(user.auth_version || 0) !== Number(record.issued_auth_version)) {
    throw new PasswordActionError('The password action link is no longer valid.', 400, 'PASSWORD_ACTION_TOKEN_INVALID');
  }
  return { EM: 'Password action link is valid.', EC: 0, code: 'PASSWORD_ACTION_TOKEN_VALID', DT: { valid: true } };
};

const completePasswordAction = async ({ token, purpose, newPassword }) => {
  const validationError = validatePassword(newPassword);
  if (validationError) throw new PasswordActionError(validationError);
  const transaction = await db.transaction();
  let user;
  try {
    const record = await loadActionToken({ token, purpose, transaction, lock: true });
    user = await User.findByPk(record.user_id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!user || !user.is_active || !['CUSTOMER', 'HANDYMAN'].includes(user.role)
      || Number(user.auth_version || 0) !== Number(record.issued_auth_version)) {
      throw new PasswordActionError('The password action link is no longer valid.', 400, 'PASSWORD_ACTION_TOKEN_INVALID');
    }
    let localProvider = await AuthProvider.findOne({
      where: { user_id: user.id, provider: 'LOCAL' },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (purpose === PASSWORD_ACTION_PURPOSES.RESET && !localProvider?.password_hash) {
      throw new PasswordActionError('The account does not have a local password.', 409, 'PASSWORD_NOT_SET');
    }
    if (purpose === PASSWORD_ACTION_PURPOSES.SET && localProvider?.password_hash) {
      throw new PasswordActionError('The account already has a local password.', 409, 'PASSWORD_ALREADY_SET');
    }
    const passwordHash = await hashUserPassword(newPassword);
    if (localProvider) await localProvider.update({ password_hash: passwordHash }, { transaction });
    else localProvider = await AuthProvider.create({ user_id: user.id, provider: 'LOCAL', password_hash: passwordHash }, { transaction });

    await user.update({ auth_version: Number(user.auth_version || 0) + 1 }, { transaction });
    await RefreshToken.update({ is_revoked: true }, { where: { user_id: user.id }, transaction });
    await record.update({ consumed_at: new Date() }, { transaction });
    await PasswordActionToken.update({ revoked_at: new Date() }, {
      where: { user_id: user.id, id: { [Op.ne]: record.id }, consumed_at: null, revoked_at: null },
      transaction
    });
    await transaction.commit();
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  }
  setImmediate(() => disconnectUserSockets(user.id));
  sendPasswordChangedEmail({ toEmail: user.email, fullName: user.full_name }).catch((error) => {
    console.error('[password-action] Password notification email failed.', { user_id: user.id, error: error?.message || 'Unknown error' });
  });
  return { EM: 'Password updated successfully. Please login again.', EC: 0, code: 'PASSWORD_CHANGED', DT: '' };
};

const changePassword = async ({ userId, currentPassword, newPassword }) => {
  const validationError = validatePassword(newPassword);
  if (validationError) throw new PasswordActionError(validationError);
  const transaction = await db.transaction();
  let user;
  try {
    user = await User.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!user || !user.is_active || !['CUSTOMER', 'HANDYMAN'].includes(user.role)) {
      throw new PasswordActionError('Password change is not allowed.', 403, 'PASSWORD_ACTION_NOT_ALLOWED');
    }
    const localProvider = await AuthProvider.findOne({
      where: { user_id: user.id, provider: 'LOCAL' }, transaction, lock: transaction.LOCK.UPDATE
    });
    if (!localProvider?.password_hash) throw new PasswordActionError('The account does not have a local password.', 409, 'PASSWORD_NOT_SET');
    if (!await checkPassword(currentPassword, localProvider.password_hash)) {
      throw new PasswordActionError('Current password is incorrect.', 400, 'CURRENT_PASSWORD_INVALID');
    }
    if (await checkPassword(newPassword, localProvider.password_hash)) {
      throw new PasswordActionError('New password must be different from the current password.', 400, 'PASSWORD_REUSE_NOT_ALLOWED');
    }
    await localProvider.update({ password_hash: await hashUserPassword(newPassword) }, { transaction });
    await user.update({ auth_version: Number(user.auth_version || 0) + 1 }, { transaction });
    await RefreshToken.update({ is_revoked: true }, { where: { user_id: user.id }, transaction });
    await PasswordActionToken.update({ revoked_at: new Date() }, {
      where: { user_id: user.id, consumed_at: null, revoked_at: null }, transaction
    });
    await transaction.commit();
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  }
  setImmediate(() => disconnectUserSockets(user.id));
  sendPasswordChangedEmail({ toEmail: user.email, fullName: user.full_name }).catch((error) => {
    console.error('[password-action] Password notification email failed.', { user_id: user.id, error: error?.message || 'Unknown error' });
  });
  return { EM: 'Password changed successfully. Please login again.', EC: 0, code: 'PASSWORD_CHANGED', DT: '' };
};

export {
  PasswordActionError,
  changePassword,
  completePasswordAction,
  requestPasswordReset,
  requestSetPassword,
  validatePasswordAction
};
