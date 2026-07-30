import { handleAdminManagementError } from './AdminUser.controller.js';
import { createAdminService, getAdminService, getAdminServices, setAdminServiceActive, updateAdminService } from '../services/AdminService.service.js';

const respond = (res, code, message, data) => {
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({ EM: message, EC: 0, code, DT: data });
};
const meta = (req) => ({ correlationId: req.correlationId, ipAddress: req.ip, userAgent: req.get('user-agent') || null });

const listAdminServices = async (req, res) => {
  try { return respond(res, 'ADMIN_SERVICES_RETRIEVED', 'Services retrieved successfully.', await getAdminServices(req.query)); }
  catch (error) { return handleAdminManagementError(req, res, error); }
};
const getAdminServiceController = async (req, res) => {
  try { return respond(res, 'ADMIN_SERVICE_RETRIEVED', 'Service retrieved successfully.', await getAdminService(req.params.serviceId)); }
  catch (error) { return handleAdminManagementError(req, res, error); }
};
const createAdminServiceController = async (req, res) => {
  try { return res.status(201).json({ EM: 'Service created successfully.', EC: 0, code: 'ADMIN_SERVICE_CREATED', DT: await createAdminService({ payload: req.body, admin: req.admin, requestMeta: meta(req) }) }); }
  catch (error) { return handleAdminManagementError(req, res, error); }
};
const updateAdminServiceController = async (req, res) => {
  try { return respond(res, 'ADMIN_SERVICE_UPDATED', 'Service updated successfully.', await updateAdminService({ serviceId: req.params.serviceId, payload: req.body, admin: req.admin, requestMeta: meta(req) })); }
  catch (error) { return handleAdminManagementError(req, res, error); }
};
const setActive = (activate) => async (req, res) => {
  try { return respond(res, activate ? 'ADMIN_SERVICE_ACTIVATED' : 'ADMIN_SERVICE_DEACTIVATED', `Service ${activate ? 'activated' : 'deactivated'} successfully.`, await setAdminServiceActive({ serviceId: req.params.serviceId, activate, admin: req.admin, requestMeta: meta(req) })); }
  catch (error) { return handleAdminManagementError(req, res, error); }
};

const activateAdminService = setActive(true);
const deactivateAdminService = setActive(false);
export { activateAdminService, createAdminServiceController, deactivateAdminService, getAdminServiceController, listAdminServices, updateAdminServiceController };
