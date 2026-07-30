import {
  PasswordActionError,
  changePassword,
  completePasswordAction,
  requestPasswordReset,
  requestSetPassword,
  validatePasswordAction
} from '../services/Password.service.js';
import { PASSWORD_ACTION_PURPOSES } from '../constants/password.constants.js';

const respond = (res, result) => res.status(result.EC === 0 ? 200 : result.EC).json(result);
const handleError = (req, res, error) => {
  if (error instanceof PasswordActionError) {
    return res.status(error.status).json({ EM: error.message, EC: error.status, code: error.code, DT: '' });
  }
  console.error('[password-action] Request failed.', {
    correlation_id: req.correlationId || null,
    error: error?.message || 'Unknown error'
  });
  return res.status(500).json({ EM: 'Unable to process the password request.', EC: 500, code: 'INTERNAL_SERVER_ERROR', DT: '' });
};

const forgotPassword = async (req, res) => {
  try {
    return respond(res, await requestPasswordReset({ email: req.body?.email, correlationId: req.correlationId }));
  } catch (error) { return handleError(req, res, error); }
};

const validateResetToken = async (req, res) => {
  try { return respond(res, await validatePasswordAction({ token: req.body?.token, purpose: PASSWORD_ACTION_PURPOSES.RESET })); }
  catch (error) { return handleError(req, res, error); }
};

const completeReset = async (req, res) => {
  try {
    if (req.body?.new_password !== req.body?.confirm_password) throw new PasswordActionError('Password confirmation does not match.');
    return respond(res, await completePasswordAction({ token: req.body?.token, purpose: PASSWORD_ACTION_PURPOSES.RESET, newPassword: req.body?.new_password }));
  } catch (error) { return handleError(req, res, error); }
};

const requestSetPasswordEmail = async (req, res) => {
  try { return respond(res, await requestSetPassword({ userId: req.user.id, correlationId: req.correlationId })); }
  catch (error) { return handleError(req, res, error); }
};

const validateSetToken = async (req, res) => {
  try { return respond(res, await validatePasswordAction({ token: req.body?.token, purpose: PASSWORD_ACTION_PURPOSES.SET })); }
  catch (error) { return handleError(req, res, error); }
};

const completeSet = async (req, res) => {
  try {
    if (req.body?.new_password !== req.body?.confirm_password) throw new PasswordActionError('Password confirmation does not match.');
    return respond(res, await completePasswordAction({ token: req.body?.token, purpose: PASSWORD_ACTION_PURPOSES.SET, newPassword: req.body?.new_password }));
  } catch (error) { return handleError(req, res, error); }
};

const changeCurrentPassword = async (req, res) => {
  try {
    if (req.body?.new_password !== req.body?.confirm_password) throw new PasswordActionError('Password confirmation does not match.');
    return respond(res, await changePassword({
      userId: req.user.id,
      currentPassword: req.body?.current_password,
      newPassword: req.body?.new_password
    }));
  } catch (error) { return handleError(req, res, error); }
};

export {
  changeCurrentPassword,
  completeReset,
  completeSet,
  forgotPassword,
  requestSetPasswordEmail,
  validateResetToken,
  validateSetToken
};
