import { createHash } from 'node:crypto';
import { Op, cast, col, literal, where as sqlWhere } from 'sequelize';
import db from '../../../core/database/connection.js';
import User from '../../identity/models/User.model.js';
import Job from '../../matchmaking/models/Job.model.js';
import JobCancellation from '../../matchmaking/models/JobCancellation.model.js';
import JobWarranty from '../../matchmaking/models/JobWarranty.model.js';
import Service from '../../matchmaking/models/Service.model.js';
import WarrantyClaim from '../../matchmaking/models/WarrantyClaim.model.js';
import WarrantyCompletionRequest from '../../matchmaking/models/WarrantyCompletionRequest.model.js';
import AdminAuditLog from '../models/AdminAuditLog.model.js';
import {
  REVIEW_AUDIT_ACTIONS,
  REVIEW_CASE_TYPES,
  REVIEW_CASE_TYPE_ORDER,
  REVIEW_STATUSES,
  REVIEW_TARGET_TYPE
} from '../constants/adminReview.constants.js';
import { AdminReviewError } from '../utils/adminReviewValidation.util.js';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const VALID_SORTS = new Set(['OLDEST', 'NEWEST']);
const CASE_TYPES = Object.values(REVIEW_CASE_TYPES);
const LATEST_REWORK_REQUEST = literal(`
  "Warranty_Completion_Request"."request_sequence" = (
    SELECT MAX("latest_rework"."request_sequence")
    FROM "Warranty_Completion_Requests" AS "latest_rework"
    WHERE "latest_rework"."warranty_id" = "Warranty_Completion_Request"."warranty_id"
  )
`);

const parsePositiveInteger = (value, fallback, maximum) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) throw new AdminReviewError('page_size must be a positive integer.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new AdminReviewError(`page_size must be between 1 and ${maximum}.`);
  }
  return parsed;
};

const parseDate = (value, field) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new AdminReviewError(`${field} must be a valid date.`);
  return date;
};

const normalizeFilters = (query = {}) => {
  const caseType = String(query.case_type || 'ALL').toUpperCase();
  const status = String(query.status || REVIEW_STATUSES.PENDING).toUpperCase();
  const sort = String(query.sort || 'OLDEST').toUpperCase();
  if (caseType !== 'ALL' && !CASE_TYPES.includes(caseType)) {
    throw new AdminReviewError('case_type is invalid.');
  }
  if (!Object.values(REVIEW_STATUSES).includes(status)) {
    throw new AdminReviewError('status is invalid.');
  }
  if (!VALID_SORTS.has(sort)) throw new AdminReviewError('sort is invalid.');
  const search = String(query.search || '').trim().replace(/[%_]/g, ' ').replace(/\s+/g, ' ');
  if (search.length > 100) throw new AdminReviewError('search must not exceed 100 characters.');
  const dateFrom = parseDate(query.date_from, 'date_from');
  const dateTo = parseDate(query.date_to, 'date_to');
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new AdminReviewError('date_from must not be after date_to.');
  }
  return {
    caseType,
    status,
    sort,
    search,
    dateFrom,
    dateTo,
    pageSize: parsePositiveInteger(query.page_size, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
  };
};

const filterFingerprint = (filters) => createHash('sha256').update(JSON.stringify({
  case_type: filters.caseType,
  status: filters.status,
  sort: filters.sort,
  search: filters.search,
  date_from: filters.dateFrom?.toISOString() || null,
  date_to: filters.dateTo?.toISOString() || null
})).digest('hex');

const encodeCursor = (item, filters) => Buffer.from(JSON.stringify({
  review_sort_at: item.review_sort_at,
  case_type: item.case_type,
  case_id: item.case_id,
  fingerprint: filterFingerprint(filters)
})).toString('base64url');

const decodeCursor = (raw, filters) => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (!parsed.review_sort_at || !CASE_TYPES.includes(parsed.case_type)
        || !parsed.case_id || parsed.fingerprint !== filterFingerprint(filters)) {
      throw new Error('invalid');
    }
    const timestamp = new Date(parsed.review_sort_at);
    if (Number.isNaN(timestamp.getTime())) throw new Error('invalid');
    return { ...parsed, timestamp, typeOrder: REVIEW_CASE_TYPE_ORDER[parsed.case_type] };
  } catch {
    throw new AdminReviewError('cursor is invalid for the current filters.');
  }
};

const dateWhere = (field, filters) => {
  if (!filters.dateFrom && !filters.dateTo) return {};
  return {
    [field]: {
      ...(filters.dateFrom ? { [Op.gte]: filters.dateFrom } : {}),
      ...(filters.dateTo ? { [Op.lte]: filters.dateTo } : {})
    }
  };
};

const sourceCursorWhere = (field, caseType, cursor, sort) => {
  if (!cursor) return {};
  const sourceOrder = REVIEW_CASE_TYPE_ORDER[caseType];
  const isOldest = sort === 'OLDEST';
  const timeOperator = isOldest ? Op.gt : Op.lt;
  const idOperator = isOldest ? Op.gt : Op.lt;
  const sourceWinsTie = isOldest
    ? sourceOrder > cursor.typeOrder
    : sourceOrder < cursor.typeOrder;
  const sameType = sourceOrder === cursor.typeOrder;
  const equalTimeBranches = [];
  if (sourceWinsTie) equalTimeBranches.push({ [field]: cursor.timestamp });
  if (sameType) {
    equalTimeBranches.push({ [field]: cursor.timestamp, id: { [idOperator]: cursor.case_id } });
  }
  return {
    [Op.or]: [
      { [field]: { [timeOperator]: cursor.timestamp } },
      ...equalTimeBranches
    ]
  };
};

const jobInclude = () => ({
  model: Job,
  required: true,
  attributes: ['id', 'current_status', 'issue_description', 'service_address', 'ward_code', 'province_code'],
  include: [
    { model: Service, attributes: ['id', 'name'], required: false },
    { model: User, as: 'Customer', attributes: ['id', 'full_name', 'email'], required: true },
    { model: User, as: 'SelectedHandyman', attributes: ['id', 'full_name', 'email'], required: true }
  ]
});

const jobCountInclude = () => ({
  model: Job,
  required: true,
  attributes: [],
  include: [
    { model: Service, attributes: [], required: false },
    { model: User, as: 'Customer', attributes: [], required: true },
    { model: User, as: 'SelectedHandyman', attributes: [], required: true }
  ]
});

const searchWhere = (filters) => {
  if (!filters.search) return {};
  const pattern = `%${filters.search}%`;
  return {
    [Op.or]: [
      sqlWhere(cast(col('Job.id'), 'varchar'), { [Op.iLike]: pattern }),
      sqlWhere(col('Job->Customer.full_name'), { [Op.iLike]: pattern }),
      sqlWhere(col('Job->Customer.email'), { [Op.iLike]: pattern }),
      sqlWhere(col('Job->SelectedHandyman.full_name'), { [Op.iLike]: pattern }),
      sqlWhere(col('Job->SelectedHandyman.email'), { [Op.iLike]: pattern })
    ]
  };
};

const maskedAddress = (job) => [job?.ward_code, job?.province_code].filter(Boolean).join(', ') || null;
const partyDto = (user) => user ? ({ id: user.id, full_name: user.full_name }) : null;
const jobDto = (job) => ({
  id: job.id,
  status: job.current_status,
  service_name: job.Service?.name || null,
  issue_summary: job.issue_description,
  masked_address: maskedAddress(job)
});

const buildItem = ({
  caseId,
  caseType,
  reviewStatus,
  timestamp,
  job,
  reasonSummary,
  heldAmount,
  allowedActions,
  outcome = null,
  audit = null
}) => ({
  case_id: caseId,
  case_type: caseType,
  review_status: reviewStatus,
  outcome,
  action_required_at: reviewStatus === REVIEW_STATUSES.PENDING ? timestamp : null,
  resolved_at: reviewStatus === REVIEW_STATUSES.RESOLVED ? timestamp : null,
  review_sort_at: timestamp,
  case_age_seconds: Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000)),
  job: jobDto(job),
  parties: {
    customer: partyDto(job.Customer),
    handyman: partyDto(job.SelectedHandyman)
  },
  reason_summary: reasonSummary,
  financial: { currency: 'VND', held_amount: heldAmount == null ? null : String(heldAmount) },
  allowed_actions: allowedActions,
  resolved_by_admin_id: audit?.admin_id || null
});

const pendingClaimItems = async (filters, cursor, transaction) => {
  const rows = await WarrantyClaim.findAll({
    where: {
      status: 'PENDING_REVIEW',
      ...dateWhere('submitted_at', filters),
      ...sourceCursorWhere('submitted_at', REVIEW_CASE_TYPES.WARRANTY_CLAIM, cursor, filters.sort),
      ...searchWhere(filters)
    },
    include: [
      jobInclude(),
      { model: JobWarranty, as: 'Warranty', required: true, where: { status: 'CLAIM_PENDING', released_at: null, refunded_at: null }, attributes: ['warranty_held_amount'] }
    ],
    order: [['submitted_at', filters.sort === 'OLDEST' ? 'ASC' : 'DESC'], ['id', filters.sort === 'OLDEST' ? 'ASC' : 'DESC']],
    limit: filters.pageSize + 1,
    subQuery: false,
    transaction
  });
  return rows.map((claim) => buildItem({
    caseId: claim.id,
    caseType: REVIEW_CASE_TYPES.WARRANTY_CLAIM,
    reviewStatus: REVIEW_STATUSES.PENDING,
    timestamp: claim.submitted_at,
    job: claim.Job,
    reasonSummary: claim.reason,
    heldAmount: claim.Warranty.warranty_held_amount,
    allowedActions: ['APPROVE_REWORK', 'REJECT_CLAIM']
  }));
};

const pendingClaimCount = (filters, transaction) => WarrantyClaim.count({
  distinct: true,
  col: 'id',
  where: { status: 'PENDING_REVIEW', ...dateWhere('submitted_at', filters), ...searchWhere(filters) },
  include: [
    jobCountInclude(),
    { model: JobWarranty, as: 'Warranty', required: true, where: { status: 'CLAIM_PENDING', released_at: null, refunded_at: null }, attributes: [] }
  ],
  subQuery: false,
  transaction
});

const pendingReworkItems = async (filters, cursor, transaction) => {
  const rows = await WarrantyCompletionRequest.findAll({
    where: {
      status: 'REJECTED',
      responded_at: { [Op.ne]: null },
      [Op.and]: LATEST_REWORK_REQUEST,
      ...dateWhere('responded_at', filters),
      ...sourceCursorWhere('responded_at', REVIEW_CASE_TYPES.WARRANTY_REWORK, cursor, filters.sort),
      ...searchWhere(filters)
    },
    include: [
      jobInclude(),
      { model: JobWarranty, as: 'Warranty', required: true, where: { status: 'REVIEW_REQUIRED', released_at: null, refunded_at: null }, attributes: ['warranty_held_amount'] },
      { model: WarrantyClaim, as: 'Claim', required: true, where: { status: 'REVIEW_REQUIRED' }, attributes: ['reason'] }
    ],
    order: [['responded_at', filters.sort === 'OLDEST' ? 'ASC' : 'DESC'], ['id', filters.sort === 'OLDEST' ? 'ASC' : 'DESC']],
    limit: filters.pageSize + 1,
    subQuery: false,
    transaction
  });
  return rows.map((request) => buildItem({
    caseId: request.id,
    caseType: REVIEW_CASE_TYPES.WARRANTY_REWORK,
    reviewStatus: REVIEW_STATUSES.PENDING,
    timestamp: request.responded_at,
    job: request.Job,
    reasonSummary: request.rejection_reason,
    heldAmount: request.Warranty.warranty_held_amount,
    allowedActions: [
      ...(Number(request.request_sequence) < 2 ? ['ALLOW_ANOTHER_REWORK'] : []),
      'RELEASE_WARRANTY_RESERVE',
      'REFUND_WARRANTY_RESERVE'
    ]
  }));
};

const pendingReworkCount = async (filters, transaction) => {
  const rows = await WarrantyCompletionRequest.findAll({
    attributes: ['warranty_id'],
    where: {
      status: 'REJECTED',
      responded_at: { [Op.ne]: null },
      [Op.and]: LATEST_REWORK_REQUEST,
      ...dateWhere('responded_at', filters),
      ...searchWhere(filters)
    },
    include: [
      jobCountInclude(),
      { model: JobWarranty, as: 'Warranty', required: true, where: { status: 'REVIEW_REQUIRED', released_at: null, refunded_at: null }, attributes: [] },
      { model: WarrantyClaim, as: 'Claim', required: true, where: { status: 'REVIEW_REQUIRED' }, attributes: [] }
    ],
    group: ['Warranty_Completion_Request.warranty_id'],
    subQuery: false,
    transaction
  });
  return rows.length;
};

const pendingCancellationItems = async (filters, cursor, transaction) => {
  const rows = await JobCancellation.findAll({
    where: {
      status: 'REVIEW_REQUIRED',
      status_when_cancelled: { [Op.in]: ['EN_ROUTE', 'ARRIVED', 'QUOTE_PENDING', 'PAYMENT_PENDING'] },
      ...dateWhere('requested_at', filters),
      ...sourceCursorWhere('requested_at', REVIEW_CASE_TYPES.CANCELLATION, cursor, filters.sort),
      ...searchWhere(filters)
    },
    include: [jobInclude()],
    order: [['requested_at', filters.sort === 'OLDEST' ? 'ASC' : 'DESC'], ['id', filters.sort === 'OLDEST' ? 'ASC' : 'DESC']],
    limit: filters.pageSize + 1,
    subQuery: false,
    transaction
  });
  return rows.filter((row) => row.Job.current_status === 'CANCELLATION_REVIEW').map((cancellation) => buildItem({
    caseId: cancellation.id,
    caseType: REVIEW_CASE_TYPES.CANCELLATION,
    reviewStatus: REVIEW_STATUSES.PENDING,
    timestamp: cancellation.requested_at || cancellation.createdAt,
    job: cancellation.Job,
    reasonSummary: cancellation.reason_code,
    heldAmount: cancellation.deposit_amount,
    allowedActions: [
      'RESOLVE_CANCELLATION_CUSTOMER_FAULT',
      'RESOLVE_CANCELLATION_HANDYMAN_FAULT',
      'RESOLVE_CANCELLATION_NEUTRAL'
    ]
  }));
};

const pendingCancellationCount = (filters, transaction) => JobCancellation.count({
  distinct: true,
  col: 'id',
  where: {
    status: 'REVIEW_REQUIRED',
    status_when_cancelled: { [Op.in]: ['EN_ROUTE', 'ARRIVED', 'QUOTE_PENDING', 'PAYMENT_PENDING'] },
    ...dateWhere('requested_at', filters),
    ...searchWhere(filters)
  },
  include: [{ ...jobCountInclude(), where: { current_status: 'CANCELLATION_REVIEW' } }],
  subQuery: false,
  transaction
});

const targetToCaseType = (targetType) => ({
  [REVIEW_TARGET_TYPE.WARRANTY_CLAIM]: REVIEW_CASE_TYPES.WARRANTY_CLAIM,
  [REVIEW_TARGET_TYPE.WARRANTY_REWORK]: REVIEW_CASE_TYPES.WARRANTY_REWORK,
  [REVIEW_TARGET_TYPE.CANCELLATION]: REVIEW_CASE_TYPES.CANCELLATION
})[targetType];

const resolvedItems = async (filters, cursor, transaction) => {
  const audits = await AdminAuditLog.findAll({
    where: {
      action: { [Op.in]: REVIEW_AUDIT_ACTIONS }
    },
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    transaction
  });
  const latest = new Map();
  audits.forEach((audit) => {
    const caseType = targetToCaseType(audit.target_type);
    if (!caseType) return;
    const key = `${caseType}:${audit.target_id}`;
    if (!latest.has(key)) latest.set(key, { audit, caseType });
  });
  for (const [key, entry] of latest) {
    const resolvedAt = new Date(entry.audit.createdAt);
    if ((filters.dateFrom && resolvedAt < filters.dateFrom)
        || (filters.dateTo && resolvedAt > filters.dateTo)) {
      latest.delete(key);
    }
  }
  const grouped = {
    WARRANTY_CLAIM: [], WARRANTY_REWORK: [], CANCELLATION: []
  };
  [...latest.values()].forEach((entry) => grouped[entry.caseType].push(entry));

  const loadRows = async (Model, entries) => {
    if (!entries.length) return [];
    return Model.findAll({
      where: { id: { [Op.in]: entries.map(({ audit }) => audit.target_id) }, ...searchWhere(filters) },
      include: [jobInclude()],
      subQuery: false,
      transaction
    });
  };
  const claims = await loadRows(WarrantyClaim, grouped.WARRANTY_CLAIM);
  const reworks = await loadRows(WarrantyCompletionRequest, grouped.WARRANTY_REWORK);
  const cancellations = await loadRows(JobCancellation, grouped.CANCELLATION);
  const rowMaps = {
    WARRANTY_CLAIM: new Map(claims.map((row) => [row.id, row])),
    WARRANTY_REWORK: new Map(reworks.map((row) => [row.id, row])),
    CANCELLATION: new Map(cancellations.filter((row) => row.status !== null).map((row) => [row.id, row]))
  };
  const allItems = [...latest.values()].flatMap(({ audit, caseType }) => {
    if (filters.caseType !== 'ALL' && filters.caseType !== caseType) return [];
    const row = rowMaps[caseType].get(audit.target_id);
    if (!row) return [];
    const item = buildItem({
      caseId: row.id,
      caseType,
      reviewStatus: REVIEW_STATUSES.RESOLVED,
      timestamp: audit.createdAt,
      job: row.Job,
      reasonSummary: audit.reason_code,
      heldAmount: audit.after_state?.held_amount || audit.before_state?.held_amount || row.deposit_amount,
      allowedActions: [],
      outcome: audit.action,
      audit
    });
    return [item];
  });
  const cursorItem = cursor ? {
    review_sort_at: cursor.review_sort_at,
    case_type: cursor.case_type,
    case_id: cursor.case_id
  } : null;
  return {
    total: allItems.length,
    items: cursorItem ? allItems.filter((item) => compareItems(item, cursorItem, filters.sort) > 0) : allItems
  };
};

const compareItems = (left, right, sort) => {
  const direction = sort === 'OLDEST' ? 1 : -1;
  const timeDiff = new Date(left.review_sort_at).getTime() - new Date(right.review_sort_at).getTime();
  if (timeDiff !== 0) return timeDiff * direction;
  const typeDiff = REVIEW_CASE_TYPE_ORDER[left.case_type] - REVIEW_CASE_TYPE_ORDER[right.case_type];
  if (typeDiff !== 0) return typeDiff * direction;
  return String(left.case_id).localeCompare(String(right.case_id)) * direction;
};

const getAdminReviewCases = async (query = {}) => {
  const filters = normalizeFilters(query);
  const cursor = decodeCursor(query.cursor, filters);
  return db.transaction({ isolationLevel: 'REPEATABLE READ', readOnly: true }, async (transaction) => {
    const loaders = [];
    const countLoaders = [];
    if (filters.status !== REVIEW_STATUSES.RESOLVED) {
      if (filters.caseType === 'ALL' || filters.caseType === REVIEW_CASE_TYPES.WARRANTY_CLAIM) {
        loaders.push(() => pendingClaimItems(filters, cursor, transaction));
        countLoaders.push(() => pendingClaimCount(filters, transaction));
      }
      if (filters.caseType === 'ALL' || filters.caseType === REVIEW_CASE_TYPES.WARRANTY_REWORK) {
        loaders.push(() => pendingReworkItems(filters, cursor, transaction));
        countLoaders.push(() => pendingReworkCount(filters, transaction));
      }
      if (filters.caseType === 'ALL' || filters.caseType === REVIEW_CASE_TYPES.CANCELLATION) {
        loaders.push(() => pendingCancellationItems(filters, cursor, transaction));
        countLoaders.push(() => pendingCancellationCount(filters, transaction));
      }
    }
    let resolvedResult = { items: [], total: 0 };
    if (filters.status !== REVIEW_STATUSES.PENDING) {
      resolvedResult = await resolvedItems(filters, cursor, transaction);
      loaders.push(async () => resolvedResult.items);
    }
    const loadedSources = [];
    for (const loadSource of loaders) loadedSources.push(await loadSource());
    const pendingCounts = [];
    for (const loadCount of countLoaders) pendingCounts.push(await loadCount());
    const merged = loadedSources.flat();
    const deduped = [...new Map(merged.map((item) => [`${item.case_type}:${item.case_id}`, item])).values()]
      .sort((left, right) => compareItems(left, right, filters.sort));
    const hasMore = deduped.length > filters.pageSize;
    const items = deduped.slice(0, filters.pageSize);
    return {
      items,
      pagination: {
        page_size: filters.pageSize,
        total_items: pendingCounts.reduce((sum, count) => sum + Number(count || 0), 0) + resolvedResult.total,
        has_more: hasMore,
        next_cursor: hasMore && items.length ? encodeCursor(items.at(-1), filters) : null
      }
    };
  });
};

export { getAdminReviewCases };
