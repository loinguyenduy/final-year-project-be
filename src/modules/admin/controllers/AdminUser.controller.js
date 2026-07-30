import { changeAccountStatus, getAdminUserDetail, getAdminUserJobs, getAdminUsers } from '../services/AdminUser.service.js';
import { AdminManagementError } from '../utils/adminManagementValidation.util.js';
import { disconnectUserSockets, emitToUsers } from '../../../core/realtime/realtime.gateway.js';
import { randomUUID } from 'node:crypto';

const handleAdminManagementError = (req, res, error) => {
  if (error instanceof AdminManagementError) {
    return res.status(error.status).json({ EM: error.message, EC: error.status, code: error.code, DT: error.data });
  }
  console.error('[admin-management] Unexpected error.', { correlation_id: req.correlationId, error: error.message });
  return res.status(500).json({ EM: 'Internal server error.', EC: 500, code: 'INTERNAL_SERVER_ERROR', DT: '' });
};

const respond = (res, code, message, data) => {
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({ EM: message, EC: 0, code, DT: data });
};

const listAdminUsers = async (req, res) => {
  try { return respond(res, 'ADMIN_USERS_RETRIEVED', 'Admin users retrieved successfully.', await getAdminUsers(req.query)); }
  catch (error) { return handleAdminManagementError(req, res, error); }
};

const getAdminUser = async (req, res) => {
  try { return respond(res, 'ADMIN_USER_RETRIEVED', 'Admin user detail retrieved successfully.', await getAdminUserDetail({ userId: req.params.userId, admin: req.admin, correlationId: req.correlationId })); }
  catch (error) { return handleAdminManagementError(req, res, error); }
};

const listAdminUserJobs = async (req, res) => {
  try { return respond(res, 'ADMIN_USER_JOBS_RETRIEVED', 'User Jobs retrieved successfully.', await getAdminUserJobs({ userId: req.params.userId, query: req.query })); }
  catch (error) { return handleAdminManagementError(req, res, error); }
};

const mutateAccount = (activate) => async (req, res) => {
  try {
    const data = await changeAccountStatus({
      userId: req.params.userId, activate, admin: req.admin, payload: req.body,
      requestMeta: { correlationId: req.correlationId, ipAddress: req.ip, userAgent: req.get('user-agent') || null }
    });
    if (!activate) {
      const event = { event_id: randomUUID(), occurred_at: new Date().toISOString(), code: 'ACCOUNT_INACTIVE', resource: { user_id: data.user.user_id } };
      emitToUsers([data.user.user_id], 'ACCOUNT_DEACTIVATED', event);
      setImmediate(() => disconnectUserSockets(data.user.user_id));
    }
    return respond(res, activate ? 'ACCOUNT_REACTIVATED' : 'ACCOUNT_DEACTIVATED', `Account ${activate ? 'reactivated' : 'deactivated'} successfully.`, data);
  } catch (error) { return handleAdminManagementError(req, res, error); }
};

const deactivateAdminUser = mutateAccount(false);
const reactivateAdminUser = mutateAccount(true);

export { deactivateAdminUser, getAdminUser, handleAdminManagementError, listAdminUserJobs, listAdminUsers, reactivateAdminUser };
