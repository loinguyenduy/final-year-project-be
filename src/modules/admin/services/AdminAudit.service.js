import { Op } from 'sequelize';
import AdminAuditLog from '../models/AdminAuditLog.model.js';
import User from '../../identity/models/User.model.js';
import {
  AUDIT_CATEGORIES,
  categoryForAction,
  knownAuditActions,
  presentAuditDetail,
  presentAuditListItem
} from './AdminAuditPresentation.service.js';

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

const normalizeSearch = (value) => {
  const normalized = String(value || '').trim().normalize('NFC').replace(/[%_]/g, ' ').replace(/\s+/g, ' ');
  if (normalized.length > 100) throw new AdminAuditQueryError('search must not exceed 100 characters.');
  return normalized;
};

const parseAuditDate = (value, field, endOfDay = false) => {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const [year, month, day] = String(value).split('-').map(Number);
    const localMidnightUtc = Date.UTC(year, month - 1, day) - (7 * 60 * 60 * 1000);
    const normalized = new Date(localMidnightUtc + (7 * 60 * 60 * 1000));
    if (normalized.getUTCFullYear() !== year || normalized.getUTCMonth() !== month - 1 || normalized.getUTCDate() !== day) {
      throw new AdminAuditQueryError(`${field} must be a valid calendar date.`);
    }
    return new Date(localMidnightUtc + (endOfDay ? (24 * 60 * 60 * 1000) - 1 : 0));
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new AdminAuditQueryError(`${field} must be a valid date.`);
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
  const search = normalizeSearch(query.search);
  const category = String(query.category || 'ALL').trim().toUpperCase();
  const sort = String(query.sort || 'CREATED_DESC').trim().toUpperCase();
  if (category !== 'ALL' && !AUDIT_CATEGORIES.includes(category)) throw new AdminAuditQueryError('category is invalid.');
  if (!['CREATED_DESC', 'CREATED_ASC'].includes(sort)) throw new AdminAuditQueryError('sort is invalid.');
  const where = {};
  ['action', 'target_type', 'target_id', 'admin_id', 'correlation_id'].forEach((field) => {
    if (query[field]) where[field] = String(query[field]).trim();
  });
  ['target_id', 'admin_id', 'correlation_id'].forEach((field) => {
    if (where[field] && !UUID_PATTERN.test(where[field])) {
      throw new AdminAuditQueryError(`${field} must be a valid UUID.`);
    }
  });
  const dateFrom = parseAuditDate(query.date_from, 'date_from');
  const dateTo = parseAuditDate(query.date_to, 'date_to', true);
  if (dateFrom && dateTo && dateFrom > dateTo) throw new AdminAuditQueryError('date_from must precede date_to.');
  if (dateFrom || dateTo) where.createdAt = { ...(dateFrom ? { [Op.gte]: dateFrom } : {}), ...(dateTo ? { [Op.lte]: dateTo } : {}) };
  const known = knownAuditActions();
  if (category !== 'ALL') {
    const actions = known.filter((item) => item.category === category).map((item) => item.value);
    where.action = category === 'OTHER'
      ? { [Op.notIn]: known.map((item) => item.value) }
      : { [Op.in]: actions };
    if (query.action) {
      const requestedAction = String(query.action).trim();
      const matchesCategory = categoryForAction(requestedAction) === category;
      where.action = matchesCategory ? requestedAction : { [Op.in]: [] };
    }
  }
  if (search) {
    const clauses = [
      { action: { [Op.iLike]: `%${search}%` } },
      { '$Administrator.full_name$': { [Op.iLike]: `%${search}%` } },
      { '$Administrator.email$': { [Op.iLike]: `%${search}%` } }
    ];
    if (UUID_PATTERN.test(search)) clauses.push(
      { id: search }, { target_id: search }, { correlation_id: search }
    );
    where[Op.or] = clauses;
  }
  const { rows, count } = await AdminAuditLog.findAndCountAll({
    where,
    attributes: ['id', 'action', 'target_type', 'target_id', 'reason_code', 'after_state', 'correlation_id', 'createdAt'],
    include: [{ model: User, as: 'Administrator', attributes: ['id', 'full_name', 'email'], required: false }],
    order: sort === 'CREATED_ASC' ? [['createdAt', 'ASC'], ['id', 'ASC']] : [['createdAt', 'DESC'], ['id', 'DESC']],
    limit: pageSize,
    offset: (page - 1) * pageSize,
    distinct: true,
    subQuery: false
  });

  return {
    items: rows.map(presentAuditListItem),
    pagination: {
      page,
      page_size: pageSize,
      total_items: count,
      total_pages: Math.ceil(count / pageSize)
    }
  };
};

const getAdminAuditFilterOptions = async () => {
  const [actorRows, targetRows, actionRows] = await Promise.all([
    AdminAuditLog.findAll({ attributes: ['admin_id'], group: ['admin_id'], raw: true }),
    AdminAuditLog.findAll({ attributes: ['target_type'], group: ['target_type'], order: [['target_type', 'ASC']], raw: true }),
    AdminAuditLog.findAll({ attributes: ['action'], group: ['action'], order: [['action', 'ASC']], raw: true })
  ]);
  const administrators = await User.findAll({
    where: { id: { [Op.in]: actorRows.map((row) => row.admin_id) }, role: 'ADMIN' },
    attributes: ['id', 'full_name', 'email'], order: [['full_name', 'ASC'], ['id', 'ASC']], raw: true
  });
  const knownItems = knownAuditActions();
  const known = new Map(knownItems.map((item) => [item.value, item]));
  const actions = [...knownItems];
  actionRows.forEach((row) => {
    if (!known.has(row.action)) actions.push({
      value: row.action,
      label: String(row.action).replaceAll('_', ' '),
      category: 'OTHER'
    });
  });
  return {
    categories: AUDIT_CATEGORIES,
    actions,
    target_types: targetRows.map((row) => row.target_type),
    administrators
  };
};

const getAdminAuditLogDetail = async (auditId) => {
  if (!UUID_PATTERN.test(String(auditId || ''))) throw new AdminAuditQueryError('auditId must be a valid UUID.');
  const audit = await AdminAuditLog.findByPk(auditId, {
    attributes: [
      'id', 'action', 'target_type', 'target_id', 'reason_code', 'reason_text',
      'before_state', 'after_state', 'correlation_id', 'createdAt'
    ],
    include: [{ model: User, as: 'Administrator', attributes: ['id', 'full_name', 'email'], required: false }]
  });
  if (!audit) {
    const error = new AdminAuditQueryError('Administrator Audit record was not found.');
    error.status = 404;
    error.code = 'ADMIN_AUDIT_LOG_NOT_FOUND';
    throw error;
  }
  return presentAuditDetail(audit);
};

export {
  AdminAuditQueryError,
  createAdminAuditLog,
  findScopedAdminDecision,
  getAdminAuditFilterOptions,
  getAdminAuditLogDetail,
  getAdminAuditLogs
};
