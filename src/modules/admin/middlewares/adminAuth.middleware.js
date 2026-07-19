import User from '../../identity/models/User.model.js';

const requireActiveAdmin = async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({
        EM: 'Admin authentication is required.',
        EC: 401,
        code: 'ADMIN_AUTH_REQUIRED',
        DT: ''
      });
    }

    const admin = await User.findByPk(req.user.id, {
      attributes: ['id', 'full_name', 'email', 'role', 'is_active']
    });
    if (!admin) {
      return res.status(401).json({
        EM: 'Admin session is no longer valid.',
        EC: 401,
        code: 'ADMIN_SESSION_EXPIRED',
        DT: ''
      });
    }
    if (admin.role !== 'ADMIN') {
      return res.status(403).json({
        EM: 'Administrator permission is required.',
        EC: 403,
        code: 'ADMIN_ROLE_REQUIRED',
        DT: ''
      });
    }
    if (!admin.is_active) {
      return res.status(403).json({
        EM: 'This administrator account is inactive.',
        EC: 403,
        code: 'ADMIN_NOT_ACTIVE',
        DT: ''
      });
    }

    req.admin = admin;
    return next();
  } catch (error) {
    console.error('[admin-auth] Unable to validate administrator.', {
      correlation_id: req.correlationId,
      error: error.message
    });
    return res.status(500).json({
      EM: 'Unable to validate the administrator session.',
      EC: 500,
      code: 'INTERNAL_SERVER_ERROR',
      DT: ''
    });
  }
};

export { requireActiveAdmin };
