import { verifyToken } from '../../../core/utils/jwt.util.js';
import User from '../../identity/models/User.model.js';

const socketAuthError = (message, code = 'SOCKET_AUTHENTICATION_FAILED', ec = 401) => {
  const envelope = { EM: message, EC: ec, code, DT: '' };
  const error = new Error(message);
  error.data = envelope;
  return error;
};

const authenticateSocket = async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token || typeof token !== 'string') {
      return next(socketAuthError('Missing access token.'));
    }

    const verification = verifyToken(token);
    if (!verification.isValid || !verification.decoded?.id) {
      return next(socketAuthError('Invalid or expired access token.'));
    }

    const user = await User.findByPk(verification.decoded.id);
    if (!user) return next(socketAuthError('User not found.'));
    if (!user.is_active) {
      return next(socketAuthError('User account is inactive.', 'PARTICIPANT_INACTIVE', 409));
    }
    const tokenAuthVersion = Number.isInteger(verification.decoded.auth_version)
      ? verification.decoded.auth_version
      : 0;
    if (verification.decoded.role !== user.role || tokenAuthVersion !== Number(user.auth_version || 0)) {
      return next(socketAuthError('This session has been revoked.', 'SESSION_REVOKED', 401));
    }
    if (!['CUSTOMER', 'HANDYMAN', 'ADMIN'].includes(user.role)) {
      return next(socketAuthError('This account role may not connect to realtime services.', 'SOCKET_UNAUTHORIZED', 403));
    }

    socket.data.user = {
      id: user.id,
      role: user.role,
      full_name: user.full_name,
      auth_version: Number(user.auth_version || 0)
    };
    return next();
  } catch (error) {
    console.error('[chat] Socket authentication failed unexpectedly.', error);
    return next(socketAuthError('Unable to authenticate socket.'));
  }
};

export { authenticateSocket };
