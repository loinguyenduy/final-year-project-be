import AdminAuditLog from '../models/AdminAuditLog.model.js';

class AdminAuditQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AdminAuditQueryError';
    this.status = 400;
    this.code = 'VALIDATION_ERROR';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUDIT_SNAPSHOT_KEYS = new Set([
  'session_state',
  'role',
  'submission_id',
  'submission_sequence',
  'user_id',
  'user_role',
  'request_status',
  'user_kyc_status',
  'document_types',
  'reviewed_by_admin_id',
  'reviewed_at',
  'case_type',
  'case_id',
  'job_id',
  'claim_status',
  'warranty_status',
  'cancellation_status',
  'job_status',
  'contract_status',
  'request_id',
  'request_sequence',
  'request_status',
  'decision',
  'classification',
  'held_amount',
  'released_amount',
  'refunded_amount',
  'customer_refund_amount',
  'handyman_compensation_amount',
  'platform_amount',
  'resolved_by_admin_id',
  'resolved_at',
  'is_active',
  'auth_version',
  'active_job_count',
  'active_jobs_by_status',
  'active_created_jobs',
  'active_assigned_jobs',
  'active_warranty_jobs',
  'pending_review_jobs',
  'service_code',
  'service_name',
  'icon_configured',
  'job_usage_count',
  'handyman_association_count'
]);
const normalizeAuditSnapshot = (snapshot) => {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('Admin audit snapshots must be plain objects.');
  }
  const normalized = {};
  Object.entries(snapshot).forEach(([key, value]) => {
    if (!AUDIT_SNAPSHOT_KEYS.has(key)) {
      throw new Error(`Admin audit snapshot field is not allowed: ${key}`);
    }
    normalized[key] = value;
  });
  return normalized;
};
const parsePositiveInteger = (value, field, fallback, maximum = Number.MAX_SAFE_INTEGER) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) throw new AdminAuditQueryError(`${field} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new AdminAuditQueryError(`${field} is outside the allowed range.`);
  }
  return parsed;
};

const createAdminAuditLog = async ({
  adminId,
  action,
  targetType,
  targetId,
  reasonCode = null,
  reasonText = null,
  beforeState = {},
  afterState = {},
  correlationId,
  ipAddress = null,
  userAgent = null,
  idempotencyKey = null,
  requestFingerprint = null,
  transaction
}) => AdminAuditLog.create({
  admin_id: adminId,
  action,
  target_type: targetType,
  target_id: targetId,
  reason_code: reasonCode,
  reason_text: reasonText,
  before_state: normalizeAuditSnapshot(beforeState),
  after_state: normalizeAuditSnapshot(afterState),
  correlation_id: correlationId,
  ip_address: ipAddress ? String(ipAddress).slice(0, 64) : null,
  user_agent: userAgent ? String(userAgent).slice(0, 512) : null,
  idempotency_key: idempotencyKey,
  request_fingerprint: requestFingerprint
}, { transaction });

const findScopedAdminDecision = ({
  action,
  targetType,
  targetId,
  idempotencyKey,
  transaction
}) => AdminAuditLog.findOne({
  where: {
    action,
    target_type: targetType,
    target_id: targetId,
    idempotency_key: idempotencyKey
  },
  transaction
});

const getAdminAuditLogs = async (query = {}) => {
  const page = parsePositiveInteger(query.page, 'page', 1);
  const pageSize = parsePositiveInteger(query.page_size, 'page_size', 20, 100);
  const where = {};
  ['action', 'target_type', 'target_id', 'admin_id'].forEach((field) => {
    if (query[field]) where[field] = String(query[field]).trim();
  });
  ['target_id', 'admin_id'].forEach((field) => {
    if (where[field] && !UUID_PATTERN.test(where[field])) {
      throw new AdminAuditQueryError(`${field} must be a valid UUID.`);
    }
  });
  const { rows, count } = await AdminAuditLog.findAndCountAll({
    where,
    attributes: { exclude: ['idempotency_key', 'request_fingerprint'] },
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    limit: pageSize,
    offset: (page - 1) * pageSize
  });

  return {
    items: rows,
    pagination: {
      page,
      page_size: pageSize,
      total_items: count,
      total_pages: Math.ceil(count / pageSize)
    }
  };
};

export {
  AdminAuditQueryError,
  createAdminAuditLog,
  findScopedAdminDecision,
  getAdminAuditLogs
};
