import { getAdminDashboard } from '../services/AdminDashboard.service.js';
import { handleAdminManagementError } from './AdminUser.controller.js';

const getDashboard = async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    const data = await getAdminDashboard(req.query);
    return res.status(200).json({
      EM: 'Administrator Dashboard retrieved successfully.',
      EC: 0,
      code: 'ADMIN_DASHBOARD_RETRIEVED',
      DT: data
    });
  } catch (error) {
    return handleAdminManagementError(req, res, error);
  }
};

export { getDashboard };
