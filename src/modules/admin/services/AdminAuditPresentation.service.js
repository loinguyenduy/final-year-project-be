import { ADMIN_AUDIT_ACTIONS } from '../constants/admin.constants.js';

const AUDIT_CATEGORIES = Object.freeze([
  'AUTHENTICATION',
  'KYC',
  'JOB_REVIEW',
  'USER_MANAGEMENT',
  'SERVICE_MANAGEMENT',
  'OTHER'
]);

const CATEGORY_BY_ACTION = Object.freeze({
  [ADMIN_AUDIT_ACTIONS.LOGIN_SUCCEEDED]: 'AUTHENTICATION',
  [ADMIN_AUDIT_ACTIONS.LOGOUT]: 'AUTHENTICATION',
  [ADMIN_AUDIT_ACTIONS.KYC_APPROVED]: 'KYC',
  [ADMIN_AUDIT_ACTIONS.KYC_REJECTED]: 'KYC',
  [ADMIN_AUDIT_ACTIONS.WARRANTY_CLAIM_APPROVED_REWORK]: 'JOB_REVIEW',
  [ADMIN_AUDIT_ACTIONS.WARRANTY_CLAIM_REJECTED]: 'JOB_REVIEW',
  [ADMIN_AUDIT_ACTIONS.WARRANTY_REWORK_ALLOWED]: 'JOB_REVIEW',
  [ADMIN_AUDIT_ACTIONS.WARRANTY_RESERVE_RELEASED]: 'JOB_REVIEW',
  [ADMIN_AUDIT_ACTIONS.WARRANTY_RESERVE_REFUNDED]: 'JOB_REVIEW',
  [ADMIN_AUDIT_ACTIONS.CANCELLATION_RESOLVED_CUSTOMER_FAULT]: 'JOB_REVIEW',
  [ADMIN_AUDIT_ACTIONS.CANCELLATION_RESOLVED_HANDYMAN_FAULT]: 'JOB_REVIEW',
  [ADMIN_AUDIT_ACTIONS.CANCELLATION_RESOLVED_NEUTRAL]: 'JOB_REVIEW',
  [ADMIN_AUDIT_ACTIONS.USER_DEACTIVATED]: 'USER_MANAGEMENT',
  [ADMIN_AUDIT_ACTIONS.USER_REACTIVATED]: 'USER_MANAGEMENT',
  [ADMIN_AUDIT_ACTIONS.SERVICE_CREATED]: 'SERVICE_MANAGEMENT',
  [ADMIN_AUDIT_ACTIONS.SERVICE_UPDATED]: 'SERVICE_MANAGEMENT',
  [ADMIN_AUDIT_ACTIONS.SERVICE_ACTIVATED]: 'SERVICE_MANAGEMENT',
  [ADMIN_AUDIT_ACTIONS.SERVICE_DEACTIVATED]: 'SERVICE_MANAGEMENT'
});

const LABEL_BY_ACTION = Object.freeze({
  [ADMIN_AUDIT_ACTIONS.LOGIN_SUCCEEDED]: 'Administrator signed in',
  [ADMIN_AUDIT_ACTIONS.LOGOUT]: 'Administrator signed out',
  [ADMIN_AUDIT_ACTIONS.KYC_APPROVED]: 'KYC submission approved',
  [ADMIN_AUDIT_ACTIONS.KYC_REJECTED]: 'KYC submission rejected',
  [ADMIN_AUDIT_ACTIONS.WARRANTY_CLAIM_APPROVED_REWORK]: 'Warranty claim approved for rework',
  [ADMIN_AUDIT_ACTIONS.WARRANTY_CLAIM_REJECTED]: 'Warranty claim rejected',
  [ADMIN_AUDIT_ACTIONS.WARRANTY_REWORK_ALLOWED]: 'Additional warranty rework allowed',
  [ADMIN_AUDIT_ACTIONS.WARRANTY_RESERVE_RELEASED]: 'Warranty reserve released',
  [ADMIN_AUDIT_ACTIONS.WARRANTY_RESERVE_REFUNDED]: 'Warranty reserve refunded',
  [ADMIN_AUDIT_ACTIONS.CANCELLATION_RESOLVED_CUSTOMER_FAULT]: 'Cancellation resolved as Customer fault',
  [ADMIN_AUDIT_ACTIONS.CANCELLATION_RESOLVED_HANDYMAN_FAULT]: 'Cancellation resolved as Handyman fault',
  [ADMIN_AUDIT_ACTIONS.CANCELLATION_RESOLVED_NEUTRAL]: 'Cancellation resolved as neutral',
  [ADMIN_AUDIT_ACTIONS.USER_DEACTIVATED]: 'Participant account deactivated',
  [ADMIN_AUDIT_ACTIONS.USER_REACTIVATED]: 'Participant account reactivated',
  [ADMIN_AUDIT_ACTIONS.SERVICE_CREATED]: 'Service created',
  [ADMIN_AUDIT_ACTIONS.SERVICE_UPDATED]: 'Service updated',
  [ADMIN_AUDIT_ACTIONS.SERVICE_ACTIVATED]: 'Service activated',
  [ADMIN_AUDIT_ACTIONS.SERVICE_DEACTIVATED]: 'Service deactivated'
});

const AUTH_KEYS = Object.freeze(['session_state', 'role']);
const KYC_KEYS = Object.freeze([
  'submission_id', 'submission_sequence', 'user_id', 'user_role', 'request_status',
  'user_kyc_status', 'document_types', 'reviewed_by_admin_id', 'reviewed_at'
]);
const REVIEW_KEYS = Object.freeze([
  'case_type', 'case_id', 'job_id', 'claim_status', 'warranty_status', 'cancellation_status',
  'job_status', 'contract_status', 'request_id', 'request_sequence', 'request_status',
  'decision', 'classification', 'held_amount', 'released_amount', 'refunded_amount',
  'customer_refund_amount', 'handyman_compensation_amount', 'platform_amount',
  'reviewed_by_admin_id', 'reviewed_at', 'resolved_by_admin_id', 'resolved_at'
]);
const USER_KEYS = Object.freeze([
  'user_id', 'user_role', 'is_active', 'auth_version', 'active_job_count',
  'active_jobs_by_status', 'active_created_jobs', 'active_assigned_jobs',
  'active_warranty_jobs', 'pending_review_jobs'
]);
const SERVICE_KEYS = Object.freeze([
  'service_code', 'service_name', 'is_active', 'icon_configured',
  'job_usage_count', 'handyman_association_count'
]);

const KEYS_BY_CATEGORY = Object.freeze({
  AUTHENTICATION: AUTH_KEYS,
  KYC: KYC_KEYS,
  JOB_REVIEW: REVIEW_KEYS,
  USER_MANAGEMENT: USER_KEYS,
  SERVICE_MANAGEMENT: SERVICE_KEYS
});

const BOOLEAN_KEYS = new Set(['is_active', 'icon_configured']);
const INTEGER_KEYS = new Set([
  'submission_sequence', 'request_sequence', 'auth_version', 'active_job_count',
  'active_created_jobs', 'active_assigned_jobs', 'active_warranty_jobs',
  'pending_review_jobs', 'job_usage_count', 'handyman_association_count'
]);
const MONEY_KEYS = new Set([
  'held_amount', 'released_amount', 'refunded_amount', 'customer_refund_amount',
  'handyman_compensation_amount', 'platform_amount'
]);
const DATE_KEYS = new Set(['reviewed_at', 'resolved_at']);
const JOB_STATUSES = new Set([
  'POSTED', 'BIDDING', 'PENDING_DEPOSIT', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED',
  'QUOTE_PENDING', 'PAYMENT_PENDING', 'CANCELLATION_REVIEW', 'IN_PROGRESS',
  'WARRANTY', 'CLOSED', 'CANCELLED'
]);
const DOCUMENT_TYPES = new Set(['CCCD_FRONT', 'CCCD_BACK', 'SELFIE', 'CERTIFICATE', 'CV']);

const categoryForAction = (action) => CATEGORY_BY_ACTION[action] || 'OTHER';
const actionLabel = (action) => LABEL_BY_ACTION[action]
  || String(action || 'Unknown action').replaceAll('_', ' ').replace(/^ADMIN /, '').toLowerCase().replace(/^./, (c) => c.toUpperCase());

const safeScalar = (key, value) => {
  if (value === null) return null;
  if (BOOLEAN_KEYS.has(key)) return typeof value === 'boolean' ? value : undefined;
  if (INTEGER_KEYS.has(key)) return Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : undefined;
  if (MONEY_KEYS.has(key)) return /^\d+(?:\.0{1,2})?$/.test(String(value)) ? String(value).split('.')[0] : undefined;
  if (DATE_KEYS.has(key)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return ['string', 'number'].includes(typeof value) ? String(value).slice(0, 500) : undefined;
};

const sanitizeSnapshot = (action, snapshot) => {
  const category = categoryForAction(action);
  if (category === 'OTHER' || !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return {};
  const result = {};
  for (const key of KEYS_BY_CATEGORY[category] || []) {
    const value = snapshot[key];
    if (value === undefined) continue;
    if (key === 'document_types') {
      if (Array.isArray(value)) result[key] = value.filter((item) => DOCUMENT_TYPES.has(item));
      continue;
    }
    if (key === 'active_jobs_by_status') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      result[key] = Object.fromEntries(Object.entries(value)
        .filter(([status, count]) => JOB_STATUSES.has(status) && Number.isSafeInteger(Number(count)) && Number(count) >= 0)
        .map(([status, count]) => [status, Number(count)]));
      continue;
    }
    const safeValue = safeScalar(key, value);
    if (safeValue !== undefined) result[key] = safeValue;
  }
  return result;
};

const targetDestination = ({ targetType, targetId, snapshot = {} }) => {
  if (targetType === 'KYC_SUBMISSION') return `/admin/kyc?submission=${encodeURIComponent(targetId)}`;
  if (targetType === 'USER_ACCOUNT') return `/admin/users/${encodeURIComponent(targetId)}`;
  if (['WARRANTY_CLAIM', 'WARRANTY_REWORK', 'JOB_CANCELLATION'].includes(targetType)) {
    return snapshot.job_id ? `/admin/jobs/${encodeURIComponent(snapshot.job_id)}?section=reviews` : '/admin/jobs?needs_review=true';
  }
  if (targetType === 'SERVICE') return `/admin/services?search=${encodeURIComponent(snapshot.service_code || targetId)}`;
  return null;
};

const presentAuditListItem = (entry) => {
  const plain = entry.get ? entry.get({ plain: true }) : entry;
  const category = categoryForAction(plain.action);
  const safeAfter = sanitizeSnapshot(plain.action, plain.after_state);
  return {
    audit_id: plain.id,
    action: plain.action,
    action_label: actionLabel(plain.action),
    category,
    detail_availability: category === 'OTHER' ? 'SUMMARY_ONLY' : 'FULL',
    administrator: plain.Administrator ? {
      id: plain.Administrator.id,
      full_name: plain.Administrator.full_name,
      email: plain.Administrator.email
    } : null,
    target: {
      type: plain.target_type,
      id: plain.target_id,
      label: String(plain.target_type || 'Target').replaceAll('_', ' '),
      destination: targetDestination({ targetType: plain.target_type, targetId: plain.target_id, snapshot: safeAfter })
    },
    reason_code: plain.reason_code || null,
    summary: LABEL_BY_ACTION[plain.action] || `Administrator action ${plain.action || 'UNKNOWN'} was recorded.`,
    correlation_id: plain.correlation_id,
    created_at: plain.createdAt
  };
};

const presentAuditDetail = (entry) => {
  const plain = entry.get ? entry.get({ plain: true }) : entry;
  const item = presentAuditListItem(plain);
  if (item.detail_availability === 'SUMMARY_ONLY') {
    return { ...item, reason_text: null, previous_state: {}, new_state: {}, safe_metadata: {} };
  }
  return {
    ...item,
    reason_text: plain.reason_text || null,
    previous_state: sanitizeSnapshot(plain.action, plain.before_state),
    new_state: sanitizeSnapshot(plain.action, plain.after_state),
    safe_metadata: {}
  };
};

const knownAuditActions = () => Object.values(ADMIN_AUDIT_ACTIONS).map((action) => ({
  value: action,
  label: actionLabel(action),
  category: categoryForAction(action)
}));

export {
  AUDIT_CATEGORIES,
  actionLabel,
  categoryForAction,
  knownAuditActions,
  presentAuditDetail,
  presentAuditListItem,
  sanitizeSnapshot
};
