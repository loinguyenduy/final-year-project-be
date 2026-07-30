import {
  AdminAuditQueryError,
  getAdminAuditFilterOptions,
  getAdminAuditLogDetail,
  getAdminAuditLogs
} from '../services/AdminAudit.service.js';

const noStore = (res) => res.setHeader('Cache-Control', 'private, no-store');

const handleAuditError = (req, res, error) => {
  if (error instanceof AdminAuditQueryError) {
    return res.status(error.status).json({ EM: error.message, EC: error.status, code: error.code, DT: '' });
  }
  console.error('[admin-audit] Unable to retrieve audit data.', {
    correlation_id: req.correlationId,
    error: error.message
  });
  return res.status(500).json({
    EM: 'Unable to retrieve administrator audit data.',
    EC: 500,
    code: 'INTERNAL_SERVER_ERROR',
    DT: ''
  });
};

const listAdminAuditLogs = async (req, res) => {
  noStore(res);
  try {
    const data = await getAdminAuditLogs(req.query);
    return res.status(200).json({
      EM: 'Administrator audit logs retrieved successfully.',
      EC: 0,
      code: 'ADMIN_AUDIT_LOGS_RETRIEVED',
      DT: data
    });
  } catch (error) {
    return handleAuditError(req, res, error);
  }
};

const getAdminAuditOptions = async (req, res) => {
  noStore(res);
  try {
    return res.status(200).json({
      EM: 'Administrator Audit filter options retrieved successfully.',
      EC: 0,
      code: 'ADMIN_AUDIT_FILTER_OPTIONS_RETRIEVED',
      DT: await getAdminAuditFilterOptions()
    });
  } catch (error) {
    return handleAuditError(req, res, error);
  }
};

const getAdminAuditDetail = async (req, res) => {
  noStore(res);
  try {
    return res.status(200).json({
      EM: 'Administrator Audit detail retrieved successfully.',
      EC: 0,
      code: 'ADMIN_AUDIT_LOG_RETRIEVED',
      DT: await getAdminAuditLogDetail(req.params.auditId)
    });
  } catch (error) {
    return handleAuditError(req, res, error);
  }
};

export { getAdminAuditDetail, getAdminAuditOptions, listAdminAuditLogs };
