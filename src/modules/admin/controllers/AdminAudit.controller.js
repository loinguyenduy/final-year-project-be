import { AdminAuditQueryError, getAdminAuditLogs } from '../services/AdminAudit.service.js';

const listAdminAuditLogs = async (req, res) => {
  try {
    const data = await getAdminAuditLogs(req.query);
    return res.status(200).json({
      EM: 'Administrator audit logs retrieved successfully.',
      EC: 0,
      code: 'ADMIN_AUDIT_LOGS_RETRIEVED',
      DT: data
    });
  } catch (error) {
    if (error instanceof AdminAuditQueryError) {
      return res.status(error.status).json({
        EM: error.message,
        EC: error.status,
        code: error.code,
        DT: ''
      });
    }
    console.error('[admin-audit] Unable to retrieve audit logs.', {
      correlation_id: req.correlationId,
      error: error.message
    });
    return res.status(500).json({
      EM: 'Unable to retrieve administrator audit logs.',
      EC: 500,
      code: 'INTERNAL_SERVER_ERROR',
      DT: ''
    });
  }
};

export { listAdminAuditLogs };
