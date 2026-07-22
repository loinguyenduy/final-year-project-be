import { createHash } from 'node:crypto';
import { Op, cast, col, fn, literal, where as sqlWhere } from 'sequelize';
import User from '../../identity/models/User.model.js';
import UserAddress from '../../identity/models/UserAddress.model.js';
import HandymanProfile from '../../identity/models/HandymanProfile.model.js';
import Province from '../../matchmaking/models/Province.model.js';
import Ward from '../../matchmaking/models/Ward.model.js';
import Service from '../../matchmaking/models/Service.model.js';
import Job from '../../matchmaking/models/Job.model.js';
import Bid from '../../matchmaking/models/Bid.model.js';
import JobStatusHistory from '../../matchmaking/models/JobStatusHistory.model.js';
import JobArrivalRequest from '../../matchmaking/models/JobArrivalRequest.model.js';
import JobCancellation from '../../matchmaking/models/JobCancellation.model.js';
import JobQuote from '../../matchmaking/models/JobQuote.model.js';
import JobQuoteItem from '../../matchmaking/models/JobQuoteItem.model.js';
import JobCompletionRequest from '../../matchmaking/models/JobCompletionRequest.model.js';
import JobWarranty from '../../matchmaking/models/JobWarranty.model.js';
import WarrantyClaim from '../../matchmaking/models/WarrantyClaim.model.js';
import WarrantyCompletionRequest from '../../matchmaking/models/WarrantyCompletionRequest.model.js';
import Wallet from '../../fintech/models/Wallet.model.js';
import Transaction from '../../fintech/models/Transaction.model.js';
import EvidenceVault from '../../fintech/models/EvidenceVault.model.js';
import EContract from '../../fintech/models/EContract.model.js';
import Conversation from '../../chat/models/Conversation.model.js';
import Message from '../../chat/models/Message.model.js';
import { decodeMessageCursor, encodeMessageCursor } from '../../chat/utils/chatCursor.util.js';
import AdminAuditLog from '../models/AdminAuditLog.model.js';
import {
  REVIEW_ACTIONS,
  REVIEW_CASE_TYPES,
  REVIEW_TARGET_TYPE
} from '../constants/adminReview.constants.js';
import {
  ADMIN_JOB_LIMITS,
  ADMIN_JOB_SORTS,
  CYCLE_ASSIGNMENTS,
  FINANCE_DIAGNOSTIC_STATUSES,
  buildDecisionRequirements
} from '../constants/adminJob.constants.js';
import { AdminReviewError, isValidUuid } from '../utils/adminReviewValidation.util.js';
import { logSensitiveAdminRead } from './AdminSecurityReadLog.service.js';
import { calculateCompletionSplit } from '../../fintech/utils/completionSettlement.util.js';
import { parseVndInteger } from '../../matchmaking/utils/cancellationPolicy.util.js';
import { getRatingSummaries } from '../../dispute/services/Rating.service.js';

const JOB_STATUSES = new Set(Job.rawAttributes.current_status.values || []);
const REVIEW_TYPES = new Set([...Object.values(REVIEW_CASE_TYPES), 'ALL']);
const BOOLEAN_VALUES = new Set(['true', 'false']);
const FINANCE_TRANSACTION_TYPES = new Set([
  'DEPOSIT_10',
  'SERVICE_REMAINING_PAYMENT',
  'HANDYMAN_PARTIAL_RELEASE',
  'PLATFORM_SERVICE_FEE',
  'WARRANTY_RESERVE_HOLD',
  'WARRANTY_RELEASE',
  'WARRANTY_REFUND',
  'DEPOSIT_REFUND',
  'CANCELLATION_REFUND',
  'CANCELLATION_COMPENSATION',
  'CANCELLATION_PLATFORM_FEE'
]);

const asPlain = (record) => record?.get ? record.get({ plain: true }) : record;
const decimal = (value) => value == null ? null : String(value);
const integer = (value) => value == null ? null : Number(value);
const normalizeText = (value) => String(value || '').trim().replace(/[%_]/g, ' ').replace(/\s+/g, ' ');
const compactText = (value, max = 80) => {
  const text = normalizeText(value);
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
};
const displayTitle = (serviceName, issueDescription) => {
  const issue = compactText(issueDescription, 80);
  return [serviceName || 'Service request', issue].filter(Boolean).join(' — ');
};

const parsePositiveInteger = (value, fallback, max, field) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) throw new AdminReviewError(`${field} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new AdminReviewError(`${field} must be between 1 and ${max}.`);
  }
  return parsed;
};

const parseBoolean = (value, field) => {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).toLowerCase();
  if (!BOOLEAN_VALUES.has(normalized)) throw new AdminReviewError(`${field} must be true or false.`);
  return normalized === 'true';
};

const parseDate = (value, field, { endOfDay = false } = {}) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new AdminReviewError(`${field} must be a valid date.`);
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) parsed.setUTCHours(23, 59, 59, 999);
  return parsed;
};

const assertUuid = (value, field = 'id') => {
  if (!isValidUuid(value)) throw new AdminReviewError(`${field} must be a valid UUID.`);
  return value;
};

const participantDto = (user, { contact = false } = {}) => user ? {
  id: user.id,
  full_name: user.full_name,
  avatar_url: user.avatar_url || null,
  role: user.role,
  ...(contact ? {
    email: user.email,
    phone_number: user.phone_number || null,
    is_active: Boolean(user.is_active),
    is_email_verified: Boolean(user.is_email_verified),
    kyc_status: user.kyc_status
  } : {})
} : null;

const mapBy = (rows, key) => new Map(rows.map((row) => {
  const plain = asPlain(row);
  return [plain[key], plain];
}));

const groupBy = (rows, key) => rows.reduce((result, row) => {
  const plain = asPlain(row);
  const value = plain[key] == null ? null : String(plain[key]);
  if (!result.has(value)) result.set(value, []);
  result.get(value).push(plain);
  return result;
}, new Map());

const normalizeJobFilters = (query = {}) => {
  const status = String(query.status || 'ALL').trim().toUpperCase();
  if (status !== 'ALL' && !JOB_STATUSES.has(status)) throw new AdminReviewError('status is invalid.');
  const reviewType = String(query.review_type || 'ALL').trim().toUpperCase();
  if (!REVIEW_TYPES.has(reviewType)) throw new AdminReviewError('review_type is invalid.');
  if (reviewType !== 'ALL' && String(query.needs_review || '').toLowerCase() === 'false') {
    throw new AdminReviewError('review_type cannot be combined with needs_review=false.');
  }
  const participantRole = String(query.participant_role || 'ALL').trim().toUpperCase();
  if (!['ALL', 'CUSTOMER', 'HANDYMAN'].includes(participantRole)) {
    throw new AdminReviewError('participant_role is invalid.');
  }
  const sort = String(query.sort || 'CREATED_DESC').trim().toUpperCase();
  if (!ADMIN_JOB_SORTS.includes(sort)) throw new AdminReviewError('sort is invalid.');
  const search = normalizeText(query.search);
  if (search.length > 100) throw new AdminReviewError('search must not exceed 100 characters.');
  const createdFrom = parseDate(query.created_from, 'created_from');
  const createdTo = parseDate(query.created_to, 'created_to', { endOfDay: true });
  if (createdFrom && createdTo && createdFrom > createdTo) {
    throw new AdminReviewError('created_from must not be after created_to.');
  }
  const serviceId = query.service_id ? assertUuid(query.service_id, 'service_id') : null;
  const participantUserId = query.participant_user_id
    ? assertUuid(query.participant_user_id, 'participant_user_id') : null;
  return {
    page: parsePositiveInteger(query.page, 1, Number.MAX_SAFE_INTEGER, 'page'),
    pageSize: parsePositiveInteger(query.page_size, ADMIN_JOB_LIMITS.DEFAULT_PAGE_SIZE, ADMIN_JOB_LIMITS.MAX_PAGE_SIZE, 'page_size'),
    search,
    status,
    serviceId,
    createdFrom,
    createdTo,
    hasSelectedHandyman: parseBoolean(query.has_selected_handyman, 'has_selected_handyman'),
    needsReview: parseBoolean(query.needs_review, 'needs_review'),
    reviewType,
    participantUserId,
    participantRole,
    acceptanceCycle: query.acceptance_cycle
      ? parsePositiveInteger(query.acceptance_cycle, null, Number.MAX_SAFE_INTEGER, 'acceptance_cycle') : null,
    sort
  };
};

const getPendingReviewMap = async () => {
  const [claims, reworks, cancellations] = await Promise.all([
    WarrantyClaim.findAll({
      where: { status: 'PENDING_REVIEW' },
      attributes: ['id', 'job_id', 'acceptance_cycle', 'warranty_id']
    }),
    WarrantyCompletionRequest.findAll({
      where: { status: 'REJECTED', responded_at: { [Op.ne]: null } },
      attributes: ['id', 'job_id', 'acceptance_cycle', 'warranty_id', 'claim_id', 'request_sequence']
    }),
    JobCancellation.findAll({
      where: {
        status: 'REVIEW_REQUIRED',
        status_when_cancelled: { [Op.in]: ['EN_ROUTE', 'ARRIVED', 'QUOTE_PENDING', 'PAYMENT_PENDING'] }
      },
      attributes: ['id', 'job_id', 'acceptance_cycle']
    })
  ]);
  const warrantyIds = [...new Set([
    ...claims.map((row) => row.warranty_id),
    ...reworks.map((row) => row.warranty_id)
  ].filter(Boolean))];
  const claimIds = [...new Set(reworks.map((row) => row.claim_id).filter(Boolean))];
  const jobIds = [...new Set([
    ...claims.map((row) => row.job_id),
    ...reworks.map((row) => row.job_id),
    ...cancellations.map((row) => row.job_id)
  ].filter(Boolean))];
  const [warranties, reworkClaims, jobs] = await Promise.all([
    warrantyIds.length ? JobWarranty.findAll({ where: { id: { [Op.in]: warrantyIds } } }) : [],
    claimIds.length ? WarrantyClaim.findAll({ where: { id: { [Op.in]: claimIds } } }) : [],
    jobIds.length ? Job.findAll({ where: { id: { [Op.in]: jobIds } }, attributes: ['id', 'current_status', 'acceptance_cycle'] }) : []
  ]);
  const warrantyById = mapBy(warranties, 'id');
  const claimById = mapBy(reworkClaims, 'id');
  const jobById = mapBy(jobs, 'id');
  const latestReworkByWarranty = new Map();
  reworks.forEach((row) => {
    const existing = latestReworkByWarranty.get(row.warranty_id);
    if (!existing || Number(row.request_sequence) > Number(existing.request_sequence)) {
      latestReworkByWarranty.set(row.warranty_id, row);
    }
  });
  const result = new Map();
  const add = (jobId, type, caseId) => {
    if (!result.has(jobId)) result.set(jobId, []);
    result.get(jobId).push({ case_type: type, case_id: caseId });
  };
  claims.forEach((claim) => {
    const warranty = warrantyById.get(claim.warranty_id);
    const job = jobById.get(claim.job_id);
    if (warranty?.status === 'CLAIM_PENDING' && !warranty.released_at && !warranty.refunded_at
        && job?.current_status === 'WARRANTY'
        && Number(job.acceptance_cycle) === Number(claim.acceptance_cycle)) {
      add(claim.job_id, REVIEW_CASE_TYPES.WARRANTY_CLAIM, claim.id);
    }
  });
  reworks.forEach((request) => {
    const warranty = warrantyById.get(request.warranty_id);
    const claim = claimById.get(request.claim_id);
    const job = jobById.get(request.job_id);
    if (latestReworkByWarranty.get(request.warranty_id)?.id === request.id
        && warranty?.status === 'REVIEW_REQUIRED' && !warranty.released_at && !warranty.refunded_at
        && claim?.status === 'REVIEW_REQUIRED' && job?.current_status === 'WARRANTY'
        && Number(job.acceptance_cycle) === Number(request.acceptance_cycle)) {
      add(request.job_id, REVIEW_CASE_TYPES.WARRANTY_REWORK, request.id);
    }
  });
  cancellations.forEach((cancellation) => {
    const job = jobById.get(cancellation.job_id);
    if (job?.current_status === 'CANCELLATION_REVIEW'
        && Number(job.acceptance_cycle) === Number(cancellation.acceptance_cycle)) {
      add(cancellation.job_id, REVIEW_CASE_TYPES.CANCELLATION, cancellation.id);
    }
  });
  return result;
};

const jobSearchWhere = (search) => {
  if (!search) return {};
  const pattern = `%${search}%`;
  return {
    [Op.or]: [
      sqlWhere(cast(col('Job.id'), 'varchar'), { [Op.iLike]: pattern }),
      { issue_description: { [Op.iLike]: pattern } },
      sqlWhere(col('Service.name'), { [Op.iLike]: pattern }),
      sqlWhere(col('Customer.full_name'), { [Op.iLike]: pattern }),
      sqlWhere(col('Customer.email'), { [Op.iLike]: pattern }),
      sqlWhere(col('Customer.phone_number'), { [Op.iLike]: pattern }),
      sqlWhere(col('SelectedHandyman.full_name'), { [Op.iLike]: pattern }),
      sqlWhere(col('SelectedHandyman.email'), { [Op.iLike]: pattern }),
      sqlWhere(col('SelectedHandyman.phone_number'), { [Op.iLike]: pattern })
    ]
  };
};

const listOrder = (sort, pendingIds) => {
  const direction = sort.endsWith('_ASC') ? 'ASC' : 'DESC';
  if (sort === 'UPDATED_DESC' || sort === 'UPDATED_ASC') return [['updatedAt', direction], ['id', direction]];
  if (sort === 'REVIEW_REQUIRED_FIRST') {
    const prioritized = pendingIds.length
      ? literal(`CASE WHEN "Job"."id" IN (${pendingIds.map((id) => `'${id}'::uuid`).join(', ')}) THEN 0 ELSE 1 END`)
      : null;
    return prioritized
      ? [[prioritized, 'ASC'], ['createdAt', 'DESC'], ['id', 'DESC']]
      : [['createdAt', 'DESC'], ['id', 'DESC']];
  }
  return [['createdAt', direction], ['id', direction]];
};

const getAdminJobs = async (query = {}) => {
  const filters = normalizeJobFilters(query);
  const pendingMap = await getPendingReviewMap();
  const pendingIds = [...pendingMap.entries()]
    .filter(([, cases]) => filters.reviewType === 'ALL' || cases.some((entry) => entry.case_type === filters.reviewType))
    .map(([jobId]) => jobId);
  const where = {
    ...(filters.status !== 'ALL' ? { current_status: filters.status } : {}),
    ...(filters.serviceId ? { service_id: filters.serviceId } : {}),
    ...(filters.acceptanceCycle ? { acceptance_cycle: filters.acceptanceCycle } : {}),
    ...(filters.hasSelectedHandyman === true ? { selected_handyman_id: { [Op.ne]: null } } : {}),
    ...(filters.hasSelectedHandyman === false ? { selected_handyman_id: null } : {}),
    ...((filters.createdFrom || filters.createdTo) ? {
      createdAt: {
        ...(filters.createdFrom ? { [Op.gte]: filters.createdFrom } : {}),
        ...(filters.createdTo ? { [Op.lte]: filters.createdTo } : {})
      }
    } : {}),
    ...(filters.needsReview === true || filters.reviewType !== 'ALL' ? { id: { [Op.in]: pendingIds } } : {}),
    ...(filters.needsReview === false && pendingIds.length ? { id: { [Op.notIn]: pendingIds } } : {}),
    ...jobSearchWhere(filters.search)
  };
  if (filters.participantRole === 'CUSTOMER') {
    if (filters.participantUserId) where.customer_id = filters.participantUserId;
  } else if (filters.participantRole === 'HANDYMAN') {
    where.selected_handyman_id = filters.participantUserId || { [Op.ne]: null };
  } else if (filters.participantUserId) {
    where[Op.and] = [
      ...(where[Op.and] || []),
      { [Op.or]: [
        { customer_id: filters.participantUserId },
        { selected_handyman_id: filters.participantUserId }
      ] }
    ];
  }
  const include = [
    { model: Service, attributes: ['id', 'service_code', 'name'], required: false },
    { model: User, as: 'Customer', attributes: ['id', 'full_name', 'avatar_url', 'role'], required: true },
    { model: User, as: 'SelectedHandyman', attributes: ['id', 'full_name', 'avatar_url', 'role'], required: false }
  ];
  const result = await Job.findAndCountAll({
    where,
    include,
    distinct: true,
    subQuery: false,
    order: listOrder(filters.sort, pendingIds),
    limit: filters.pageSize,
    offset: (filters.page - 1) * filters.pageSize
  });
  const jobs = result.rows.map(asPlain);
  const jobIds = jobs.map((job) => job.id);
  const [bidCounts, contracts, warranties, cancellations] = jobIds.length ? await Promise.all([
    Bid.findAll({
      where: { job_id: { [Op.in]: jobIds } },
      attributes: ['job_id', [fn('COUNT', col('id')), 'count']],
      group: ['job_id'], raw: true
    }),
    EContract.findAll({ where: { job_id: { [Op.in]: jobIds } }, order: [['acceptance_cycle', 'DESC']] }),
    JobWarranty.findAll({ where: { job_id: { [Op.in]: jobIds } }, order: [['acceptance_cycle', 'DESC']] }),
    JobCancellation.findAll({ where: { job_id: { [Op.in]: jobIds } }, order: [['createdAt', 'DESC']] })
  ]) : [[], [], [], []];
  const countByJob = new Map(bidCounts.map((entry) => [entry.job_id, Number(entry.count)]));
  const contractByJobCycle = new Map(contracts.map((entry) => [`${entry.job_id}:${entry.acceptance_cycle}`, asPlain(entry)]));
  const warrantyByJobCycle = new Map(warranties.map((entry) => [`${entry.job_id}:${entry.acceptance_cycle}`, asPlain(entry)]));
  const cancellationByJobCycle = new Map();
  cancellations.forEach((entry) => {
    const key = `${entry.job_id}:${entry.acceptance_cycle}`;
    if (!cancellationByJobCycle.has(key)) cancellationByJobCycle.set(key, asPlain(entry));
  });
  return {
    items: jobs.map((job) => {
      const cycleKey = `${job.id}:${job.acceptance_cycle}`;
      const contract = contractByJobCycle.get(cycleKey);
      const warranty = warrantyByJobCycle.get(cycleKey);
      const cancellation = cancellationByJobCycle.get(cycleKey);
      const pending = pendingMap.get(job.id) || [];
      return {
        id: job.id,
        display_title: displayTitle(job.Service?.name, job.issue_description),
        service: job.Service || null,
        issue_summary: compactText(job.issue_description, 180),
        status: job.current_status,
        acceptance_cycle: Number(job.acceptance_cycle),
        scheduled_at: job.scheduled_at,
        created_at: job.createdAt,
        updated_at: job.updatedAt,
        address_summary: [job.detail_address, job.ward_code, job.province_code].filter(Boolean).join(', '),
        budget: {
          min: decimal(job.estimated_budget_min),
          max: decimal(job.estimated_budget_max),
          final_agreed_price: decimal(job.final_agreed_price),
          currency: 'VND'
        },
        customer: participantDto(job.Customer),
        selected_handyman: participantDto(job.SelectedHandyman),
        bid_count: countByJob.get(job.id) || 0,
        contract: contract ? { id: contract.id, number: contract.contract_number, status: contract.status } : null,
        warranty: warranty ? { id: warranty.id, status: warranty.status, ends_at: warranty.ends_at } : null,
        cancellation: cancellation ? { id: cancellation.id, status: cancellation.status, classification: cancellation.classification } : null,
        needs_review: pending.length > 0,
        pending_review_types: [...new Set(pending.map((entry) => entry.case_type))]
      };
    }),
    pagination: {
      page: filters.page,
      page_size: filters.pageSize,
      total_items: Number(result.count),
      total_pages: Math.max(1, Math.ceil(Number(result.count) / filters.pageSize))
    },
    applied_filters: {
      search: filters.search || null,
      status: filters.status,
      service_id: filters.serviceId,
      created_from: filters.createdFrom,
      created_to: filters.createdTo,
      has_selected_handyman: filters.hasSelectedHandyman,
      needs_review: filters.needsReview,
      review_type: filters.reviewType,
      participant_user_id: filters.participantUserId,
      participant_role: filters.participantRole,
      acceptance_cycle: filters.acceptanceCycle,
      sort: filters.sort
    }
  };
};

const safeSnapshot = (value) => {
  const blocked = /(url|token|password|cookie|wallet_id|gps|public_id|latitude|longitude)/i;
  if (Array.isArray(value)) return value.map(safeSnapshot);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !blocked.test(key))
    .map(([key, entry]) => [key, safeSnapshot(entry)]));
};

const evidenceDto = (entry) => ({
  id: entry.id,
  acceptance_cycle: integer(entry.acceptance_cycle),
  stage: entry.stage,
  media_type: entry.media_type,
  mime_type: entry.mime_type,
  file_size: entry.file_size,
  uploader: participantDto(entry.Uploader),
  uploaded_at: entry.uploaded_at
});

const bidDto = (entry, selectedBidId) => ({
  id: entry.id,
  handyman: participantDto(entry.User, { contact: true }),
  proposed_price: decimal(entry.proposed_price),
  currency: 'VND',
  message: entry.message,
  eta: entry.eta,
  estimated_duration_hours: entry.estimated_duration_hours,
  status: entry.status,
  is_selected: entry.id === selectedBidId,
  created_at: entry.createdAt,
  updated_at: entry.updatedAt
});

const quoteDto = (quote) => ({
  id: quote.id,
  acceptance_cycle: Number(quote.acceptance_cycle),
  version: Number(quote.version),
  status: quote.status,
  problem_summary: quote.problem_summary,
  inspection_notes: quote.inspection_notes,
  recommended_solution: quote.recommended_solution,
  estimated_duration_minutes: quote.estimated_duration_minutes,
  warranty_days: quote.warranty_days,
  subtotal_amount: decimal(quote.subtotal_amount),
  discount_amount: decimal(quote.discount_amount),
  total_amount: decimal(quote.total_amount),
  currency: quote.currency,
  variance_amount: decimal(quote.variance_amount),
  variance_percent: decimal(quote.variance_percent),
  variance_reason: quote.variance_reason,
  variance_reason_text: quote.variance_reason_text,
  submitted_at: quote.submitted_at,
  accepted_at: quote.accepted_at,
  rejected_at: quote.rejected_at,
  rejection_reason: quote.rejection_reason,
  rejection_reason_text: quote.rejection_reason_text,
  items: (quote.Items || []).map((item) => ({
    id: item.id,
    item_type: item.item_type,
    name: item.name,
    description: item.description,
    quantity: item.quantity,
    unit: item.unit,
    unit_price: decimal(item.unit_price),
    line_total: decimal(item.line_total),
    sort_order: item.sort_order
  }))
});

const contractDto = (contract) => ({
  id: contract.id,
  acceptance_cycle: Number(contract.acceptance_cycle),
  quote_id: contract.quote_id,
  contract_number: contract.contract_number,
  status: contract.status,
  currency: contract.currency,
  subtotal_amount: decimal(contract.subtotal_amount),
  discount_amount: decimal(contract.discount_amount),
  quote_total_amount: decimal(contract.quote_total_amount),
  deposit_amount: decimal(contract.deposit_amount),
  remaining_payment_amount: decimal(contract.remaining_payment_amount),
  full_escrow_amount: decimal(contract.full_escrow_amount),
  problem_summary: contract.problem_summary,
  inspection_notes: contract.inspection_notes,
  recommended_solution: contract.recommended_solution,
  estimated_duration_minutes: contract.estimated_duration_minutes,
  warranty_days: contract.warranty_days,
  customer_name_snapshot: contract.customer_name_snapshot,
  handyman_name_snapshot: contract.handyman_name_snapshot,
  service_address_snapshot: contract.service_address_snapshot,
  effective_at: contract.effective_at,
  pdf_available: Boolean(contract.pdf_url)
});

const warrantyDto = (warranty) => ({
  id: warranty.id,
  acceptance_cycle: Number(warranty.acceptance_cycle),
  contract_id: warranty.contract_id,
  status: warranty.status,
  warranty_days: warranty.warranty_days,
  started_at: warranty.started_at,
  ends_at: warranty.ends_at,
  total_amount: decimal(warranty.total_amount),
  handyman_immediate_amount: decimal(warranty.handyman_immediate_amount),
  platform_fee_amount: decimal(warranty.platform_fee_amount),
  held_amount: decimal(warranty.warranty_held_amount),
  released_amount: decimal(warranty.warranty_released_amount),
  refunded_amount: decimal(warranty.warranty_refunded_amount),
  released_at: warranty.released_at,
  refunded_at: warranty.refunded_at,
  rework_cycle_count: Number(warranty.rework_cycle_count)
});

const claimDto = (claim) => ({
  id: claim.id,
  acceptance_cycle: Number(claim.acceptance_cycle),
  warranty_id: claim.warranty_id,
  status: claim.status,
  reason: claim.reason,
  description: claim.description,
  submitted_at: claim.submitted_at,
  reviewed_at: claim.reviewed_at,
  reviewed_by_admin_id: claim.reviewed_by_admin_id,
  resolved_at: claim.resolved_at,
  resolved_by_admin_id: claim.resolved_by_admin_id,
  admin_note: claim.admin_note
});

const reworkDto = (request) => ({
  id: request.id,
  acceptance_cycle: Number(request.acceptance_cycle),
  warranty_id: request.warranty_id,
  claim_id: request.claim_id,
  request_sequence: Number(request.request_sequence),
  status: request.status,
  completion_note: request.completion_note,
  requested_at: request.requested_at,
  responded_at: request.responded_at,
  rejection_reason: request.rejection_reason,
  rejection_note: request.rejection_note
});

const cancellationDto = (entry) => ({
  id: entry.id,
  acceptance_cycle: integer(entry.acceptance_cycle),
  status: entry.status,
  status_when_cancelled: entry.status_when_cancelled,
  cancelled_by_role: entry.cancelled_by_role,
  cancellation_action: entry.cancellation_action,
  reason_code: entry.reason_code,
  reason_text: entry.reason_text,
  classification: entry.classification,
  resolution_mode: entry.resolution_mode,
  deposit_amount: decimal(entry.deposit_amount),
  refund_amount: decimal(entry.refund_amount),
  handyman_compensation_amount: decimal(entry.handyman_compensation_amount),
  platform_amount: decimal(entry.platform_amount),
  penalty_amount: decimal(entry.penalty_amount),
  requested_at: entry.requested_at,
  counterparty_responded_at: entry.counterparty_responded_at,
  counterparty_response: entry.counterparty_response,
  counterparty_response_note: entry.counterparty_response_note,
  resolved_at: entry.resolved_at,
  resolution_note: entry.resolution_note
});

const completionDto = (request) => ({
  id: request.id,
  acceptance_cycle: Number(request.acceptance_cycle),
  status: request.status,
  request_sequence: Number(request.request_sequence),
  completion_note: request.completion_note,
  requested_at: request.requested_at,
  responded_at: request.responded_at,
  rejection_reason: request.rejection_reason,
  rejection_note: request.rejection_note
});

const arrivalDto = (entry, { includeCoordinates = false } = {}) => ({
  id: entry.id,
  acceptance_cycle: Number(entry.acceptance_cycle),
  status: entry.status,
  request_gps_accuracy_meters: decimal(entry.request_gps_accuracy_meters),
  distance_to_job_meters: entry.distance_to_job_meters,
  location_warning: entry.location_warning,
  requested_at: entry.requested_at,
  responded_at: entry.responded_at,
  rejection_reason: entry.rejection_reason,
  rejection_reason_text: entry.rejection_reason_text,
  ...(includeCoordinates ? {
    request_gps_lat: decimal(entry.request_gps_lat),
    request_gps_long: decimal(entry.request_gps_long)
  } : {})
});

const sumParsed = (rows) => rows.reduce((result, row) => {
  if (!result.valid) return result;
  const parsed = parseVndInteger(row.amount);
  return parsed.valid ? { valid: true, amount: result.amount + parsed.amount } : { valid: false, amount: 0n };
}, { valid: true, amount: 0n });

const financeDiagnostic = ({ cycle, contract, warranty, transactions, quotes = [], completions = [] }) => {
  const relevant = transactions.filter((entry) => Number(entry.acceptance_cycle) === Number(cycle)
    && FINANCE_TRANSACTION_TYPES.has(entry.transaction_type));
  if (!contract && !warranty && relevant.length === 0) {
    return { status: FINANCE_DIAGNOSTIC_STATUSES.NOT_APPLICABLE, reasons: [], acceptance_cycle: cycle };
  }
  if (!contract || !warranty) {
    return {
      status: FINANCE_DIAGNOSTIC_STATUSES.PARTIAL_LEGACY,
      reasons: [!contract ? 'CONTRACT_SOURCE_MISSING' : 'WARRANTY_SOURCE_MISSING'],
      acceptance_cycle: cycle
    };
  }
  const contractTotal = parseVndInteger(contract.full_escrow_amount);
  const contractQuoteTotal = parseVndInteger(contract.quote_total_amount);
  const contractDeposit = parseVndInteger(contract.deposit_amount);
  const contractRemaining = parseVndInteger(contract.remaining_payment_amount);
  const warrantyTotal = parseVndInteger(warranty.total_amount);
  const handymanSnapshot = parseVndInteger(warranty.handyman_immediate_amount);
  const platformSnapshot = parseVndInteger(warranty.platform_fee_amount);
  const held = parseVndInteger(warranty.warranty_held_amount);
  const released = parseVndInteger(warranty.warranty_released_amount);
  const refunded = parseVndInteger(warranty.warranty_refunded_amount);
  const split = contractTotal.valid ? calculateCompletionSplit(contractTotal.amount) : { valid: false };
  const directMismatch = !contractTotal.valid || !contractQuoteTotal.valid || !contractDeposit.valid
    || !contractRemaining.valid || !warrantyTotal.valid || !handymanSnapshot.valid
    || !platformSnapshot.valid || !held.valid || !released.valid || !refunded.valid || !split.valid
    || contractQuoteTotal.amount !== contractTotal.amount
    || contractDeposit.amount + contractRemaining.amount !== contractTotal.amount
    || warrantyTotal.amount !== contractTotal.amount
    || handymanSnapshot.amount !== split.handymanAmount
    || platformSnapshot.amount !== split.platformAmount
    || held.amount !== split.warrantyAmount
    || warranty.contract_id !== contract.id || warranty.quote_id !== contract.quote_id;
  if (directMismatch) {
    return {
      status: FINANCE_DIAGNOSTIC_STATUSES.INCONSISTENT,
      reasons: ['CONTRACT_WARRANTY_SNAPSHOT_MISMATCH'], acceptance_cycle: cycle
    };
  }
  const quote = quotes.find((entry) => entry.id === contract.quote_id) || null;
  const completion = completions.find((entry) => entry.id === warranty.completion_request_id) || null;
  const missingReferences = [
    ...(!quote ? ['QUOTE_SOURCE_MISSING'] : []),
    ...(!completion ? ['COMPLETION_SOURCE_MISSING'] : [])
  ];
  if (missingReferences.length) {
    return {
      status: FINANCE_DIAGNOSTIC_STATUSES.PARTIAL_LEGACY,
      reasons: missingReferences,
      acceptance_cycle: cycle,
      expected_reserve: split.warrantyAmount.toString()
    };
  }
  const quoteTotal = parseVndInteger(quote.total_amount);
  if (!quoteTotal.valid || quoteTotal.amount !== contractQuoteTotal.amount
      || Number(quote.acceptance_cycle) !== Number(cycle)
      || Number(completion.acceptance_cycle) !== Number(cycle)
      || completion.status !== 'CONFIRMED') {
    return {
      status: FINANCE_DIAGNOSTIC_STATUSES.INCONSISTENT,
      reasons: ['QUOTE_COMPLETION_REFERENCE_MISMATCH'], acceptance_cycle: cycle
    };
  }
  const holds = relevant.filter((entry) => entry.status === 'SUCCESS' && entry.transaction_type === 'WARRANTY_RESERVE_HOLD');
  const releases = relevant.filter((entry) => entry.status === 'SUCCESS' && entry.transaction_type === 'WARRANTY_RELEASE');
  const refunds = relevant.filter((entry) => entry.status === 'SUCCESS' && entry.transaction_type === 'WARRANTY_REFUND');
  if (holds.length === 0) {
    return {
      status: FINANCE_DIAGNOSTIC_STATUSES.PARTIAL_LEGACY,
      reasons: ['WARRANTY_HOLD_LEDGER_MISSING'], acceptance_cycle: cycle,
      expected_reserve: split.warrantyAmount.toString()
    };
  }
  const holdAmount = sumParsed(holds);
  const releasedLedger = sumParsed(releases);
  const refundedLedger = sumParsed(refunds);
  const ledgerReferencesMissing = [...holds, ...releases, ...refunds].some((entry) => !entry.warranty_id)
    || holds.some((entry) => !entry.quote_id || !entry.completion_request_id);
  const ledgerReferencesMismatch = [...holds, ...releases, ...refunds]
    .some((entry) => entry.warranty_id && entry.warranty_id !== warranty.id)
    || holds.some((entry) => (entry.quote_id && entry.quote_id !== contract.quote_id)
      || (entry.completion_request_id && entry.completion_request_id !== warranty.completion_request_id));
  const inconsistent = holds.length !== 1 || !holdAmount.valid || !releasedLedger.valid || !refundedLedger.valid
    || holdAmount.amount !== split.warrantyAmount
    || releasedLedger.amount !== released.amount || refundedLedger.amount !== refunded.amount
    || releases.length > 1 || refunds.length > 1 || (releases.length > 0 && refunds.length > 0)
    || released.amount + refunded.amount > split.warrantyAmount
    || (released.amount > 0n && (!warranty.released_at || warranty.release_transaction_id !== releases[0]?.id))
    || (refunded.amount > 0n && (!warranty.refunded_at || warranty.refund_transaction_id !== refunds[0]?.id))
    || (released.amount === 0n && (warranty.released_at || warranty.release_transaction_id || releases.length))
    || (refunded.amount === 0n && (warranty.refunded_at || warranty.refund_transaction_id || refunds.length))
    || ledgerReferencesMismatch;
  if (!inconsistent && ledgerReferencesMissing) {
    return {
      status: FINANCE_DIAGNOSTIC_STATUSES.PARTIAL_LEGACY,
      reasons: ['LEDGER_REFERENCE_MISSING'], acceptance_cycle: cycle,
      expected_reserve: split.warrantyAmount.toString(),
      released_total: releasedLedger.amount.toString(),
      refunded_total: refundedLedger.amount.toString(),
      remaining_reserve: (split.warrantyAmount - releasedLedger.amount - refundedLedger.amount).toString()
    };
  }
  return {
    status: inconsistent ? FINANCE_DIAGNOSTIC_STATUSES.INCONSISTENT : FINANCE_DIAGNOSTIC_STATUSES.CONSISTENT,
    reasons: inconsistent ? ['WARRANTY_LEDGER_METADATA_MISMATCH'] : [],
    acceptance_cycle: cycle,
    expected_reserve: split.warrantyAmount.toString(),
    released_total: releasedLedger.valid ? releasedLedger.amount.toString() : null,
    refunded_total: refundedLedger.valid ? refundedLedger.amount.toString() : null,
    remaining_reserve: releasedLedger.valid && refundedLedger.valid
      ? (split.warrantyAmount - releasedLedger.amount - refundedLedger.amount).toString() : null
  };
};

const allowedActionsFor = ({ caseType, record, job, warranty, claim, latestRework }) => {
  if (caseType === REVIEW_CASE_TYPES.WARRANTY_CLAIM) {
    return record.status === 'PENDING_REVIEW' && warranty?.status === 'CLAIM_PENDING'
      && !warranty.released_at && !warranty.refunded_at && job.current_status === 'WARRANTY'
      && Number(record.acceptance_cycle) === Number(job.acceptance_cycle)
      ? [REVIEW_ACTIONS.APPROVE_REWORK, REVIEW_ACTIONS.REJECT_CLAIM] : [];
  }
  if (caseType === REVIEW_CASE_TYPES.WARRANTY_REWORK) {
    if (latestRework?.id !== record.id || record.status !== 'REJECTED'
        || warranty?.status !== 'REVIEW_REQUIRED' || claim?.status !== 'REVIEW_REQUIRED'
        || warranty.released_at || warranty.refunded_at || job.current_status !== 'WARRANTY'
        || Number(record.acceptance_cycle) !== Number(job.acceptance_cycle)) return [];
    return [
      ...(Number(record.request_sequence) < 2 ? [REVIEW_ACTIONS.ALLOW_ANOTHER_REWORK] : []),
      REVIEW_ACTIONS.RELEASE_WARRANTY_RESERVE,
      REVIEW_ACTIONS.REFUND_WARRANTY_RESERVE
    ];
  }
  return record.status === 'REVIEW_REQUIRED' && job.current_status === 'CANCELLATION_REVIEW'
    && Number(record.acceptance_cycle) === Number(job.acceptance_cycle)
    ? [
      REVIEW_ACTIONS.RESOLVE_CANCELLATION_CUSTOMER_FAULT,
      REVIEW_ACTIONS.RESOLVE_CANCELLATION_HANDYMAN_FAULT,
      REVIEW_ACTIONS.RESOLVE_CANCELLATION_NEUTRAL
    ] : [];
};

const buildReviewCases = ({ job, claims, reworks, cancellations, warranties }) => {
  const warrantyById = mapBy(warranties, 'id');
  const claimById = mapBy(claims, 'id');
  const latestRework = new Map();
  reworks.forEach((entry) => {
    const current = latestRework.get(entry.warranty_id);
    if (!current || Number(entry.request_sequence) > Number(current.request_sequence)) latestRework.set(entry.warranty_id, entry);
  });
  const result = [];
  claims.forEach((record) => {
    const actions = allowedActionsFor({
      caseType: REVIEW_CASE_TYPES.WARRANTY_CLAIM,
      record, job, warranty: warrantyById.get(record.warranty_id)
    });
    result.push({
      case_type: REVIEW_CASE_TYPES.WARRANTY_CLAIM,
      case_id: record.id,
      acceptance_cycle: Number(record.acceptance_cycle),
      state: record.status,
      summary: claimDto(record),
      allowed_actions: actions,
      decision_requirements: buildDecisionRequirements(actions)
    });
  });
  reworks.forEach((record) => {
    const actions = allowedActionsFor({
      caseType: REVIEW_CASE_TYPES.WARRANTY_REWORK,
      record,
      job,
      warranty: warrantyById.get(record.warranty_id),
      claim: claimById.get(record.claim_id),
      latestRework: latestRework.get(record.warranty_id)
    });
    result.push({
      case_type: REVIEW_CASE_TYPES.WARRANTY_REWORK,
      case_id: record.id,
      acceptance_cycle: Number(record.acceptance_cycle),
      state: record.status,
      summary: reworkDto(record),
      allowed_actions: actions,
      decision_requirements: buildDecisionRequirements(actions)
    });
  });
  cancellations.filter((record) => record.status != null).forEach((record) => {
    const actions = allowedActionsFor({ caseType: REVIEW_CASE_TYPES.CANCELLATION, record, job });
    result.push({
      case_type: REVIEW_CASE_TYPES.CANCELLATION,
      case_id: record.id,
      acceptance_cycle: integer(record.acceptance_cycle),
      state: record.status,
      summary: cancellationDto(record),
      allowed_actions: actions,
      decision_requirements: buildDecisionRequirements(actions)
    });
  });
  return result.sort((left, right) => new Date(right.summary.submitted_at || right.summary.requested_at || 0)
    - new Date(left.summary.submitted_at || left.summary.requested_at || 0));
};

const timelineEvent = ({ sourceType, sourceId, eventType, occurredAt, cycle = null, assignment, title, status, actor = null }) => ({
  event_id: `${sourceType}:${sourceId}:${eventType}`,
  source_type: sourceType,
  source_id: sourceId,
  event_type: eventType,
  occurred_at: occurredAt,
  acceptance_cycle: cycle == null ? null : Number(cycle),
  cycle_assignment: assignment,
  title,
  status: status || null,
  actor
});

const buildTimeline = ({ histories, bids, arrivals, quotes, evidence, completions, warranties, claims, reworks, cancellations, conversations, audits }) => {
  const events = [];
  let inferredCycle = 0;
  [...histories].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).forEach((entry) => {
    if (entry.new_status === 'ACCEPTED') inferredCycle += 1;
    const assigned = inferredCycle > 0 ? inferredCycle : null;
    events.push(timelineEvent({
      sourceType: 'JOB_STATUS_HISTORY', sourceId: entry.id, eventType: 'JOB_STATUS_CHANGED',
      occurredAt: entry.createdAt, cycle: assigned,
      assignment: assigned ? CYCLE_ASSIGNMENTS.INFERRED : CYCLE_ASSIGNMENTS.JOB_LEVEL,
      title: `${entry.old_status || 'NEW'} → ${entry.new_status}`, status: entry.new_status,
      actor: participantDto(entry.User)
    }));
  });
  bids.forEach((entry) => events.push(timelineEvent({
    sourceType: 'BID', sourceId: entry.id, eventType: 'BID_RECORDED', occurredAt: entry.createdAt,
    assignment: CYCLE_ASSIGNMENTS.JOB_LEVEL, title: 'Bid recorded', status: entry.status,
    actor: participantDto(entry.User)
  })));
  const addCanonical = (rows, sourceType, timestamp, title, status) => rows.forEach((entry) => {
    const occurredAt = typeof timestamp === 'function' ? timestamp(entry) : entry[timestamp];
    if (!occurredAt) return;
    events.push(timelineEvent({
      sourceType, sourceId: entry.id, eventType: `${sourceType}_${entry.status || 'RECORDED'}`,
      occurredAt, cycle: entry.acceptance_cycle, assignment: CYCLE_ASSIGNMENTS.CANONICAL,
      title: typeof title === 'function' ? title(entry) : title,
      status: typeof status === 'function' ? status(entry) : entry[status || 'status']
    }));
  });
  addCanonical(arrivals, 'ARRIVAL_REQUEST', (entry) => entry.requested_at, 'Arrival requested');
  addCanonical(quotes, 'QUOTE', (entry) => entry.submitted_at || entry.createdAt, 'Quote updated');
  addCanonical(evidence, 'EVIDENCE', (entry) => entry.uploaded_at, (entry) => `${entry.stage} evidence uploaded`, () => 'AVAILABLE');
  addCanonical(completions, 'COMPLETION_REQUEST', (entry) => entry.requested_at, 'Completion requested');
  addCanonical(warranties, 'WARRANTY', (entry) => entry.started_at, 'Warranty started');
  addCanonical(claims, 'WARRANTY_CLAIM', (entry) => entry.submitted_at, 'Warranty claim submitted');
  addCanonical(reworks, 'WARRANTY_REWORK', (entry) => entry.requested_at, 'Warranty rework submitted');
  addCanonical(cancellations, 'CANCELLATION', (entry) => entry.requested_at || entry.createdAt, 'Cancellation recorded');
  addCanonical(conversations, 'CONVERSATION', (entry) => entry.createdAt, 'Conversation created');
  audits.forEach((entry) => events.push(timelineEvent({
    sourceType: 'ADMIN_AUDIT', sourceId: entry.id, eventType: entry.action, occurredAt: entry.createdAt,
    cycle: entry.after_state?.acceptance_cycle || entry.before_state?.acceptance_cycle || null,
    assignment: entry.after_state?.acceptance_cycle || entry.before_state?.acceptance_cycle
      ? CYCLE_ASSIGNMENTS.CANONICAL : CYCLE_ASSIGNMENTS.JOB_LEVEL,
    title: 'Administrator decision', status: entry.action,
    actor: participantDto(entry.Administrator)
  })));
  const deduped = [...new Map(events.map((event) => [event.event_id, event])).values()];
  return deduped.sort((left, right) => {
    const delta = new Date(left.occurred_at) - new Date(right.occurred_at);
    return delta || left.event_id.localeCompare(right.event_id);
  });
};

const loadJobOrThrow = async (jobId) => {
  assertUuid(jobId, 'jobId');
  const job = await Job.findByPk(jobId, {
    include: [
      { model: Service, attributes: ['id', 'service_code', 'name', 'icon_url'] },
      { model: Province, attributes: ['province_code', 'name', 'short_name'] },
      { model: Ward, attributes: ['ward_code', 'name'] },
      { model: User, as: 'Customer' },
      { model: User, as: 'SelectedHandyman' },
      { model: User, as: 'ArrivalConfirmedBy', attributes: ['id', 'full_name', 'role'] }
    ]
  });
  if (!job) throw new AdminReviewError('Job was not found.', 404, 'ADMIN_JOB_NOT_FOUND');
  return asPlain(job);
};

const loadParticipants = async (job) => {
  const ids = [job.customer_id, job.selected_handyman_id].filter(Boolean);
  const [addresses, wallets, handymanProfile, ratings] = await Promise.all([
    UserAddress.findAll({
      where: { user_id: { [Op.in]: ids } },
      include: [
        { model: Province, attributes: ['province_code', 'name'] },
        { model: Ward, attributes: ['ward_code', 'name'] }
      ],
      order: [['is_default', 'DESC'], ['createdAt', 'DESC']]
    }),
    Wallet.findAll({
      where: { user_id: { [Op.in]: ids } },
      attributes: ['user_id', 'wallet_type', 'currency', 'balance', 'is_blocked'],
      order: [['wallet_type', 'ASC']]
    }),
    job.selected_handyman_id
      ? HandymanProfile.findOne({ where: { user_id: job.selected_handyman_id } }) : null,
    getRatingSummaries([
      job.Customer ? { id: job.Customer.id, role: 'CUSTOMER' } : null,
      job.SelectedHandyman ? { id: job.SelectedHandyman.id, role: 'HANDYMAN' } : null
    ].filter(Boolean))
  ]);
  const addressesByUser = groupBy(addresses, 'user_id');
  const walletsByUser = groupBy(wallets, 'user_id');
  const decorate = (user) => user ? {
    ...participantDto(user, { contact: true }),
    addresses: (addressesByUser.get(user.id) || []).map((address) => ({
      id: address.id,
      province_code: address.province_code,
      province_name: address.Province?.name || null,
      ward_code: address.ward_code,
      ward_name: address.Ward?.name || null,
      detail_address: address.detail_address,
      full_address: address.full_address,
      is_default: Boolean(address.is_default)
    })),
    wallets: (walletsByUser.get(user.id) || []).map((wallet) => ({
      wallet_type: wallet.wallet_type,
      currency: wallet.currency,
      available_balance: decimal(wallet.balance),
      status: wallet.is_blocked ? 'BLOCKED' : 'ACTIVE'
    }))
  } : null;
  return {
    customer: job.Customer ? { ...decorate(job.Customer), rating_summary: ratings.get(job.Customer.id) } : null,
    handyman: job.SelectedHandyman ? {
      ...decorate(job.SelectedHandyman),
      profile: handymanProfile ? {
        rating_summary: ratings.get(job.SelectedHandyman.id),
        total_jobs_completed: handymanProfile.total_jobs_completed,
        accepted_cancellation_count: handymanProfile.accepted_cancellation_count,
        security_bond_status: handymanProfile.security_bond_status,
        handyman_level: handymanProfile.handyman_level,
        bio: handymanProfile.bio,
        preferred_work_times: handymanProfile.preferred_work_times
      } : null
    } : null
  };
};

const loadJobResources = async (jobId) => {
  const [bids, bidCount, histories, arrivals, quotes, contracts, evidence, evidenceCounts, completions,
    warranties, claims, reworks, cancellations, conversations, transactions] = await Promise.all([
    Bid.findAll({
      where: { job_id: jobId }, include: [{ model: User, attributes: ['id', 'full_name', 'email', 'phone_number', 'avatar_url', 'role', 'is_active', 'is_email_verified', 'kyc_status'] }],
      order: [['createdAt', 'ASC'], ['id', 'ASC']], limit: ADMIN_JOB_LIMITS.AGGREGATE_BIDS + 1
    }),
    Bid.count({ where: { job_id: jobId } }),
    JobStatusHistory.findAll({
      where: { job_id: jobId }, include: [{ model: User, attributes: ['id', 'full_name', 'role'] }],
      order: [['createdAt', 'ASC'], ['id', 'ASC']]
    }),
    JobArrivalRequest.findAll({ where: { job_id: jobId }, order: [['requested_at', 'ASC'], ['id', 'ASC']] }),
    JobQuote.findAll({
      where: { job_id: jobId }, include: [{ model: JobQuoteItem, as: 'Items' }],
      order: [['acceptance_cycle', 'ASC'], ['version', 'ASC']]
    }),
    EContract.findAll({ where: { job_id: jobId }, order: [['acceptance_cycle', 'ASC']] }),
    EvidenceVault.findAll({
      where: { job_id: jobId }, include: [{ model: User, as: 'Uploader', attributes: ['id', 'full_name', 'role'] }],
      order: [['acceptance_cycle', 'DESC'], ['uploaded_at', 'DESC'], ['id', 'DESC']],
      limit: ADMIN_JOB_LIMITS.AGGREGATE_CYCLES * ADMIN_JOB_LIMITS.EVIDENCE_PER_CYCLE + 1
    }),
    EvidenceVault.count({ where: { job_id: jobId }, group: ['acceptance_cycle'] }),
    JobCompletionRequest.findAll({ where: { job_id: jobId }, order: [['acceptance_cycle', 'ASC'], ['request_sequence', 'ASC']] }),
    JobWarranty.findAll({ where: { job_id: jobId }, order: [['acceptance_cycle', 'ASC']] }),
    WarrantyClaim.findAll({ where: { job_id: jobId }, order: [['submitted_at', 'ASC']] }),
    WarrantyCompletionRequest.findAll({ where: { job_id: jobId }, order: [['acceptance_cycle', 'ASC'], ['request_sequence', 'ASC']] }),
    JobCancellation.findAll({ where: { job_id: jobId }, order: [['createdAt', 'ASC']] }),
    Conversation.findAll({ where: { job_id: jobId }, order: [['acceptance_cycle', 'ASC']] }),
    Transaction.findAll({ where: { job_id: jobId }, order: [['createdAt', 'ASC'], ['id', 'ASC']] })
  ]);
  return {
    bids: bids.map(asPlain), bidCount: Number(bidCount), histories: histories.map(asPlain), arrivals: arrivals.map(asPlain),
    quotes: quotes.map(asPlain), contracts: contracts.map(asPlain), evidence: evidence.map(asPlain),
    evidenceCounts, completions: completions.map(asPlain), warranties: warranties.map(asPlain),
    claims: claims.map(asPlain), reworks: reworks.map(asPlain), cancellations: cancellations.map(asPlain),
    conversations: conversations.map(asPlain), transactions: transactions.map(asPlain)
  };
};

const loadRelevantAudits = async (resources) => {
  const targets = [
    ...resources.claims.map((entry) => ({ target_type: REVIEW_TARGET_TYPE.WARRANTY_CLAIM, target_id: entry.id })),
    ...resources.reworks.map((entry) => ({ target_type: REVIEW_TARGET_TYPE.WARRANTY_REWORK, target_id: entry.id })),
    ...resources.cancellations.filter((entry) => entry.status != null)
      .map((entry) => ({ target_type: REVIEW_TARGET_TYPE.CANCELLATION, target_id: entry.id }))
  ];
  if (!targets.length) return [];
  const rows = await AdminAuditLog.findAll({
    where: { [Op.or]: targets },
    include: [{ model: User, as: 'Administrator', attributes: ['id', 'full_name', 'role'] }],
    order: [['createdAt', 'ASC'], ['id', 'ASC']]
  });
  return rows.map(asPlain);
};

const cycleNumbers = (job, resources) => {
  const values = new Set(Number(job.acceptance_cycle) > 0 ? [Number(job.acceptance_cycle)] : []);
  ['arrivals', 'quotes', 'contracts', 'evidence', 'completions', 'warranties', 'claims', 'reworks', 'cancellations', 'conversations', 'transactions']
    .forEach((key) => resources[key].forEach((entry) => {
      if (Number(entry.acceptance_cycle) > 0) values.add(Number(entry.acceptance_cycle));
    }));
  return [...values].sort((a, b) => b - a);
};

const capCyclesKeepingCurrent = (cycles, currentCycle, limit) => {
  const capped = cycles.slice(0, limit);
  const current = Number(currentCycle);
  if (current > 0 && !capped.includes(current)) {
    if (capped.length >= limit) capped[capped.length - 1] = current;
    else capped.push(current);
    capped.sort((left, right) => right - left);
  }
  return capped;
};

const cycleBundle = ({ cycle, job, resources, reviewCases, evidenceCountMap }) => {
  const select = (key) => resources[key].filter((entry) => Number(entry.acceptance_cycle) === Number(cycle));
  const contracts = select('contracts');
  const warranties = select('warranties');
  const evidence = select('evidence').slice(0, ADMIN_JOB_LIMITS.EVIDENCE_PER_CYCLE);
  const finance = financeDiagnostic({
    cycle,
    contract: contracts.at(-1) || null,
    warranty: warranties.at(-1) || null,
    transactions: resources.transactions,
    quotes: select('quotes'),
    completions: select('completions')
  });
  const evidenceTotal = evidenceCountMap.get(String(cycle)) || 0;
  const evidenceLast = evidence.at(-1);
  const evidenceFingerprint = createHash('sha256').update(`${job.id}:${cycle}:EVIDENCE`).digest('hex');
  return {
    acceptance_cycle: Number(cycle),
    is_current: Number(cycle) === Number(job.acceptance_cycle),
    conversation: select('conversations').map((entry) => ({
      id: entry.id, status: entry.status, closed_at: entry.closed_at,
      closed_reason: entry.closed_reason, last_message_at: entry.last_message_at
    })).at(-1) || null,
    arrivals: select('arrivals').map((entry) => arrivalDto(entry)),
    quotes: select('quotes').map(quoteDto),
    contracts: contracts.map(contractDto),
    evidence: {
      items: evidence.map(evidenceDto), total_count: evidenceTotal,
      has_more: evidenceTotal > evidence.length,
      next_cursor: evidenceTotal > evidence.length && evidenceLast
        ? Buffer.from(JSON.stringify({
          at: evidenceLast.uploaded_at,
          id: evidenceLast.id,
          fingerprint: evidenceFingerprint
        })).toString('base64url') : null
    },
    completion_requests: select('completions').map(completionDto),
    warranties: warranties.map(warrantyDto),
    warranty_claims: select('claims').map(claimDto),
    warranty_reworks: select('reworks').map(reworkDto),
    cancellations: select('cancellations').map(cancellationDto),
    finance,
    review_cases: reviewCases.filter((entry) => Number(entry.acceptance_cycle) === Number(cycle))
  };
};

const getAdminJobDetail = async ({ jobId, admin, correlationId }) => {
  const job = await loadJobOrThrow(jobId);
  const [participants, resources] = await Promise.all([loadParticipants(job), loadJobResources(jobId)]);
  const audits = await loadRelevantAudits(resources);
  const reviewCases = buildReviewCases({ job, ...resources });
  const cycles = cycleNumbers(job, resources);
  const includedCycles = capCyclesKeepingCurrent(
    cycles, job.acceptance_cycle, ADMIN_JOB_LIMITS.AGGREGATE_CYCLES
  );
  const indexedCycles = capCyclesKeepingCurrent(
    cycles, job.acceptance_cycle, ADMIN_JOB_LIMITS.CYCLE_INDEX
  );
  const aggregateReviewCases = reviewCases.filter((entry) => includedCycles.includes(Number(entry.acceptance_cycle)));
  const evidenceCountMap = new Map(resources.evidenceCounts.map((entry) => [String(entry.acceptance_cycle), Number(entry.count)]));
  const timeline = buildTimeline({ ...resources, audits });
  const bidRows = resources.bids.slice(0, ADMIN_JOB_LIMITS.AGGREGATE_BIDS);
  const auditRows = audits.slice(-ADMIN_JOB_LIMITS.AUDITS).reverse();
  const timelineRows = timeline.slice(-ADMIN_JOB_LIMITS.TIMELINE);
  const timelineFirst = timelineRows.at(0);
  const timelineFingerprint = createHash('sha256').update(`${job.id}:ALL:TIMELINE`).digest('hex');
  const auditLast = auditRows.at(-1);
  const auditFingerprint = createHash('sha256').update(`${job.id}:AUDITS`).digest('hex');
  const imageItems = (Array.isArray(job.images) ? job.images : []).filter((url) => typeof url === 'string' && url.trim()).map((url, index) => ({
    key: createHash('sha256').update(url).digest('hex').slice(0, 32),
    position: index + 1,
    media_type: 'IMAGE'
  }));
  logSensitiveAdminRead({
    adminId: admin.id, jobId: job.id, resourceType: 'JOB_DETAIL', correlationId
  });
  return {
    job: {
      id: job.id,
      display_title: displayTitle(job.Service?.name, job.issue_description),
      issue_description: job.issue_description,
      status: job.current_status,
      acceptance_cycle: Number(job.acceptance_cycle),
      service: job.Service || null,
      scheduled_at: job.scheduled_at,
      accepted_at: job.accepted_at,
      en_route_at: job.en_route_at,
      arrived_at: job.arrived_at,
      in_progress_at: job.in_progress_at,
      cancelled_at: job.cancelled_at,
      contact_unlocked_at: job.contact_unlocked_at,
      created_at: job.createdAt,
      updated_at: job.updatedAt,
      selected_bid_id: job.selected_bid_id,
      deposit: {
        amount: decimal(job.deposit_amount), status: job.deposit_status,
        paid_at: job.deposit_paid_at
      },
      budget: {
        min: decimal(job.estimated_budget_min), max: decimal(job.estimated_budget_max),
        final_agreed_price: decimal(job.final_agreed_price), currency: 'VND'
      },
      images: { items: imageItems, total_count: imageItems.length, has_more: false }
    },
    location: {
      address: {
        service_address: job.service_address,
        detail_address: job.detail_address,
        ward_code: job.ward_code,
        ward_name: job.Ward?.name || null,
        province_code: job.province_code,
        province_name: job.Province?.name || null
      },
      job_pin: {
        gps_lat: decimal(job.gps_lat), gps_long: decimal(job.gps_long),
        source: job.location_source, confirmed: job.location_confirmed,
        confirmed_at: job.location_confirmed_at
      },
      en_route: {
        gps_lat: decimal(job.en_route_gps_lat), gps_long: decimal(job.en_route_gps_long),
        accuracy_meters: decimal(job.en_route_gps_accuracy_meters),
        distance_meters: job.en_route_distance_meters,
        estimated_arrival_minutes: job.en_route_estimated_arrival_minutes,
        started_at: job.en_route_at
      },
      arrivals: resources.arrivals.map((entry) => arrivalDto(entry, { includeCoordinates: true })),
      confirmed_by: participantDto(job.ArrivalConfirmedBy)
    },
    participants,
    bids: {
      items: bidRows.map((entry) => bidDto(entry, job.selected_bid_id)),
      total_count: resources.bidCount,
      has_more: resources.bidCount > ADMIN_JOB_LIMITS.AGGREGATE_BIDS
    },
    acceptance_cycles: {
      index: indexedCycles.map((cycle) => ({
        acceptance_cycle: cycle,
        is_current: cycle === Number(job.acceptance_cycle)
      })),
      items: includedCycles.map((cycle) => cycleBundle({ cycle, job, resources, reviewCases, evidenceCountMap })),
      total_count: cycles.length,
      has_more: cycles.length > ADMIN_JOB_LIMITS.AGGREGATE_CYCLES,
      index_has_more: cycles.length > ADMIN_JOB_LIMITS.CYCLE_INDEX
    },
    timeline: {
      items: timelineRows,
      total_count: timeline.length,
      has_more: timeline.length > ADMIN_JOB_LIMITS.TIMELINE,
      next_cursor: timeline.length > ADMIN_JOB_LIMITS.TIMELINE && timelineFirst
        ? encodeCursor({ at: timelineFirst.occurred_at, id: timelineFirst.event_id, fingerprint: timelineFingerprint }) : null
    },
    review_cases: aggregateReviewCases,
    admin_decisions: {
      items: auditRows.map((entry) => ({
        id: entry.id,
        action: entry.action,
        target_type: entry.target_type,
        target_id: entry.target_id,
        reason_code: entry.reason_code,
        reason_text: entry.reason_text,
        before_state: safeSnapshot(entry.before_state),
        after_state: safeSnapshot(entry.after_state),
        administrator: participantDto(entry.Administrator),
        created_at: entry.createdAt
      })),
      total_count: audits.length,
      has_more: audits.length > ADMIN_JOB_LIMITS.AUDITS,
      next_cursor: audits.length > ADMIN_JOB_LIMITS.AUDITS && auditLast
        ? encodeCursor({ at: auditLast.createdAt, id: auditLast.id, fingerprint: auditFingerprint }) : null
    },
    finance_summary: includedCycles.map((cycle) => {
      const contract = resources.contracts.find((entry) => Number(entry.acceptance_cycle) === cycle) || null;
      const warranty = resources.warranties.find((entry) => Number(entry.acceptance_cycle) === cycle) || null;
      return financeDiagnostic({
        cycle,
        contract,
        warranty,
        transactions: resources.transactions,
        quotes: resources.quotes.filter((entry) => Number(entry.acceptance_cycle) === cycle),
        completions: resources.completions.filter((entry) => Number(entry.acceptance_cycle) === cycle)
      });
    }),
    section_counts: {
      bids: resources.bidCount,
      acceptance_cycles: cycles.length,
      evidence: resources.evidenceCounts.reduce((total, entry) => total + Number(entry.count), 0),
      review_cases: reviewCases.length,
      pending_review_cases: reviewCases.filter((entry) => entry.allowed_actions.length > 0).length,
      admin_decisions: audits.length,
      transactions: resources.transactions.length
    }
  };
};

const normalizeCursorPage = (query, { defaultLimit = ADMIN_JOB_LIMITS.CURSOR_DEFAULT } = {}) => ({
  limit: parsePositiveInteger(query.limit, defaultLimit, ADMIN_JOB_LIMITS.CURSOR_MAX, 'limit'),
  cursor: query.cursor || null
});

const encodeCursor = (payload) => Buffer.from(JSON.stringify(payload)).toString('base64url');
const decodeCursor = (cursor, fingerprint) => {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (parsed.fingerprint !== fingerprint || !parsed.id || !parsed.at) throw new Error('invalid');
    const at = new Date(parsed.at);
    if (Number.isNaN(at.getTime())) throw new Error('invalid');
    return { ...parsed, at };
  } catch {
    throw new AdminReviewError('cursor is invalid for the current filters.', 400, 'INVALID_CURSOR');
  }
};

const getAdminJobBids = async ({ jobId, query }) => {
  const job = await loadJobOrThrow(jobId);
  const page = parsePositiveInteger(query.page, 1, Number.MAX_SAFE_INTEGER, 'page');
  const pageSize = parsePositiveInteger(query.page_size, 50, ADMIN_JOB_LIMITS.MAX_PAGE_SIZE, 'page_size');
  const { rows, count } = await Bid.findAndCountAll({
    where: { job_id: job.id },
    include: [{ model: User, attributes: ['id', 'full_name', 'email', 'phone_number', 'avatar_url', 'role', 'is_active', 'is_email_verified', 'kyc_status'] }],
    order: [['createdAt', 'ASC'], ['id', 'ASC']], limit: pageSize, offset: (page - 1) * pageSize
  });
  return {
    items: rows.map((entry) => bidDto(asPlain(entry), job.selected_bid_id)),
    pagination: { page, page_size: pageSize, total_items: count, total_pages: Math.max(1, Math.ceil(count / pageSize)) }
  };
};

const getCycleIndex = async (jobId) => {
  const job = await loadJobOrThrow(jobId);
  const resources = await loadJobResources(jobId);
  return { job, resources, cycles: cycleNumbers(job, resources) };
};

const getAdminJobCycles = async ({ jobId, query }) => {
  const { job, cycles } = await getCycleIndex(jobId);
  const limit = parsePositiveInteger(query.limit, 20, 50, 'limit');
  let start = 0;
  if (query.cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(String(query.cursor), 'base64url').toString('utf8'));
      if (parsed.job_id !== job.id || !Number.isInteger(parsed.offset) || parsed.offset < 0) throw new Error('invalid');
      start = parsed.offset;
    } catch {
      throw new AdminReviewError('cursor is invalid for this Job.', 400, 'INVALID_CURSOR');
    }
  }
  const items = cycles.slice(start, start + limit).map((cycle) => ({
    acceptance_cycle: cycle, is_current: cycle === Number(job.acceptance_cycle)
  }));
  const nextOffset = start + items.length;
  return {
    items,
    total_count: cycles.length,
    has_more: nextOffset < cycles.length,
    next_cursor: nextOffset < cycles.length ? encodeCursor({ job_id: job.id, offset: nextOffset }) : null
  };
};

const getAdminJobCycleDetail = async ({ jobId, acceptanceCycle }) => {
  const job = await loadJobOrThrow(jobId);
  const cycle = parsePositiveInteger(acceptanceCycle, null, Number.MAX_SAFE_INTEGER, 'acceptanceCycle');
  const resources = await loadJobResources(jobId);
  if (!cycleNumbers(job, resources).includes(cycle)) {
    throw new AdminReviewError('Acceptance cycle was not found for this Job.', 404, 'ADMIN_JOB_CYCLE_NOT_FOUND');
  }
  const [cycleEvidence, cycleEvidenceCount] = await Promise.all([
    EvidenceVault.findAll({
      where: { job_id: job.id, acceptance_cycle: cycle },
      include: [{ model: User, as: 'Uploader', attributes: ['id', 'full_name', 'role'] }],
      order: [['uploaded_at', 'DESC'], ['id', 'DESC']],
      limit: ADMIN_JOB_LIMITS.EVIDENCE_PER_CYCLE + 1
    }),
    EvidenceVault.count({ where: { job_id: job.id, acceptance_cycle: cycle } })
  ]);
  resources.evidence = cycleEvidence.map(asPlain);
  resources.evidenceCounts = [{ acceptance_cycle: cycle, count: cycleEvidenceCount }];
  const audits = await loadRelevantAudits(resources);
  const reviewCases = buildReviewCases({ job, ...resources });
  const evidenceCountMap = new Map(resources.evidenceCounts.map((entry) => [String(entry.acceptance_cycle), Number(entry.count)]));
  return cycleBundle({ cycle, job, resources, reviewCases, evidenceCountMap });
};

const getAdminJobEvidence = async ({ jobId, query }) => {
  const job = await loadJobOrThrow(jobId);
  const cycle = query.acceptance_cycle
    ? parsePositiveInteger(query.acceptance_cycle, null, Number.MAX_SAFE_INTEGER, 'acceptance_cycle') : null;
  const { limit, cursor } = normalizeCursorPage(query);
  const fingerprint = createHash('sha256').update(`${job.id}:${cycle || 'ALL'}:EVIDENCE`).digest('hex');
  const decoded = decodeCursor(cursor, fingerprint);
  const rows = await EvidenceVault.findAll({
    where: {
      job_id: job.id,
      ...(cycle ? { acceptance_cycle: cycle } : {}),
      ...(decoded ? { [Op.or]: [
        { uploaded_at: { [Op.lt]: decoded.at } },
        { uploaded_at: decoded.at, id: { [Op.lt]: decoded.id } }
      ] } : {})
    },
    include: [{ model: User, as: 'Uploader', attributes: ['id', 'full_name', 'role'] }],
    order: [['uploaded_at', 'DESC'], ['id', 'DESC']], limit: limit + 1
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map(asPlain);
  const last = page.at(-1);
  return {
    items: page.map(evidenceDto), has_more: hasMore,
    next_cursor: hasMore && last ? encodeCursor({ at: last.uploaded_at, id: last.id, fingerprint }) : null
  };
};

const getAdminJobTimeline = async ({ jobId, query }) => {
  const job = await loadJobOrThrow(jobId);
  const cycle = query.acceptance_cycle
    ? parsePositiveInteger(query.acceptance_cycle, null, Number.MAX_SAFE_INTEGER, 'acceptance_cycle') : null;
  const { limit, cursor } = normalizeCursorPage(query);
  const resources = await loadJobResources(job.id);
  const audits = await loadRelevantAudits(resources);
  const fingerprint = createHash('sha256').update(`${job.id}:${cycle || 'ALL'}:TIMELINE`).digest('hex');
  const decoded = decodeCursor(cursor, fingerprint);
  const all = buildTimeline({ ...resources, audits }).reverse()
    .filter((event) => !cycle || Number(event.acceptance_cycle) === cycle)
    .filter((event) => !decoded || new Date(event.occurred_at) < decoded.at
      || (new Date(event.occurred_at).getTime() === decoded.at.getTime() && event.event_id < decoded.id));
  const page = all.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.reverse(), has_more: all.length > limit,
    next_cursor: all.length > limit && last
      ? encodeCursor({ at: last.occurred_at, id: last.event_id, fingerprint }) : null
  };
};

const getAdminJobAudits = async ({ jobId, query }) => {
  const job = await loadJobOrThrow(jobId);
  const { limit, cursor } = normalizeCursorPage(query);
  const resources = await loadJobResources(job.id);
  const audits = await loadRelevantAudits(resources);
  const fingerprint = createHash('sha256').update(`${job.id}:AUDITS`).digest('hex');
  const decoded = decodeCursor(cursor, fingerprint);
  const filtered = audits.slice().reverse().filter((entry) => !decoded
    || new Date(entry.createdAt) < decoded.at
    || (new Date(entry.createdAt).getTime() === decoded.at.getTime() && entry.id < decoded.id));
  const page = filtered.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((entry) => ({
      id: entry.id, action: entry.action, target_type: entry.target_type, target_id: entry.target_id,
      reason_code: entry.reason_code, reason_text: entry.reason_text,
      before_state: safeSnapshot(entry.before_state), after_state: safeSnapshot(entry.after_state),
      administrator: participantDto(entry.Administrator), created_at: entry.createdAt
    })),
    has_more: filtered.length > limit,
    next_cursor: filtered.length > limit && last
      ? encodeCursor({ at: last.createdAt, id: last.id, fingerprint }) : null
  };
};

const getAdminJobChat = async ({ jobId, query, admin, correlationId }) => {
  const job = await loadJobOrThrow(jobId);
  const cycle = query.acceptance_cycle
    ? parsePositiveInteger(query.acceptance_cycle, null, Number.MAX_SAFE_INTEGER, 'acceptance_cycle')
    : Number(job.acceptance_cycle);
  const limit = parsePositiveInteger(query.limit, ADMIN_JOB_LIMITS.CHAT_DEFAULT, ADMIN_JOB_LIMITS.CURSOR_MAX, 'limit');
  const conversation = await Conversation.findOne({ where: { job_id: job.id, acceptance_cycle: cycle } });
  if (!conversation) return { acceptance_cycle: cycle, conversation: null, messages: [], next_cursor: null, has_more: false };
  let cursorWhere = {};
  if (query.cursor) {
    try {
      const decoded = decodeMessageCursor(query.cursor, conversation.id);
      cursorWhere = { [Op.or]: [
        { createdAt: { [Op.lt]: decoded.createdAt } },
        { createdAt: decoded.createdAt, id: { [Op.lt]: decoded.id } }
      ] };
    } catch {
      throw new AdminReviewError('Chat cursor is invalid.', 400, 'INVALID_CURSOR');
    }
  }
  const rows = await Message.findAll({
    where: { conversation_id: conversation.id, ...cursorWhere },
    include: [{ model: User, as: 'Sender', attributes: ['id', 'full_name', 'role', 'avatar_url'] }],
    order: [['createdAt', 'DESC'], ['id', 'DESC']], limit: limit + 1
  });
  const hasMore = rows.length > limit;
  const descending = rows.slice(0, limit);
  const oldest = descending.at(-1);
  logSensitiveAdminRead({ adminId: admin.id, jobId: job.id, resourceType: 'CHAT', acceptanceCycle: cycle, correlationId });
  return {
    acceptance_cycle: cycle,
    conversation: {
      id: conversation.id, status: conversation.status, closed_at: conversation.closed_at,
      closed_reason: conversation.closed_reason
    },
    messages: descending.reverse().map((message) => ({
      id: message.id, sender: participantDto(message.Sender),
      message_type: message.message_type, content: message.content, sent_at: message.createdAt
    })),
    has_more: hasMore,
    next_cursor: hasMore && oldest ? encodeMessageCursor({
      conversationId: conversation.id, createdAt: oldest.createdAt, id: oldest.id
    }) : null
  };
};

const walletParty = (wallet, job) => {
  if (!wallet) return null;
  if (String(wallet.wallet_type).startsWith('SYSTEM_')) return { type: 'SYSTEM', wallet_type: wallet.wallet_type };
  if (wallet.user_id === job.customer_id) return { type: 'CUSTOMER', wallet_type: wallet.wallet_type };
  if (wallet.user_id === job.selected_handyman_id) return { type: 'HANDYMAN', wallet_type: wallet.wallet_type };
  return { type: 'PARTICIPANT', wallet_type: wallet.wallet_type };
};

const getAdminJobTransactions = async ({ jobId, query, admin, correlationId }) => {
  const job = await loadJobOrThrow(jobId);
  const cycle = query.acceptance_cycle
    ? parsePositiveInteger(query.acceptance_cycle, null, Number.MAX_SAFE_INTEGER, 'acceptance_cycle') : null;
  const type = query.type ? String(query.type).toUpperCase() : null;
  const status = query.status ? String(query.status).toUpperCase() : null;
  if (type && !Transaction.rawAttributes.transaction_type.values.includes(type)) throw new AdminReviewError('type is invalid.');
  if (status && !Transaction.rawAttributes.status.values.includes(status)) throw new AdminReviewError('status is invalid.');
  const { limit, cursor } = normalizeCursorPage(query);
  const fingerprint = createHash('sha256').update(`${job.id}:${cycle || 'ALL'}:${type || 'ALL'}:${status || 'ALL'}:TX`).digest('hex');
  const decoded = decodeCursor(cursor, fingerprint);
  const rows = await Transaction.findAll({
    where: {
      job_id: job.id,
      ...(cycle ? { acceptance_cycle: cycle } : {}),
      ...(type ? { transaction_type: type } : {}),
      ...(status ? { status } : {}),
      ...(decoded ? { [Op.or]: [
        { createdAt: { [Op.lt]: decoded.at } },
        { createdAt: decoded.at, id: { [Op.lt]: decoded.id } }
      ] } : {})
    },
    include: [
      { model: Wallet, as: 'FromWallet', attributes: ['user_id', 'wallet_type', 'currency'] },
      { model: Wallet, as: 'ToWallet', attributes: ['user_id', 'wallet_type', 'currency'] }
    ],
    order: [['createdAt', 'DESC'], ['id', 'DESC']], limit: limit + 1
  });
  const quoteIds = [...new Set(rows.map((entry) => entry.quote_id).filter(Boolean))];
  const warrantyIds = [...new Set(rows.map((entry) => entry.warranty_id).filter(Boolean))];
  const [contractsByQuote, warranties] = await Promise.all([
    quoteIds.length ? EContract.findAll({ where: { quote_id: { [Op.in]: quoteIds } }, attributes: ['id', 'quote_id'] }) : [],
    warrantyIds.length ? JobWarranty.findAll({ where: { id: { [Op.in]: warrantyIds } }, attributes: ['id', 'contract_id'] }) : []
  ]);
  const contractByQuote = new Map(contractsByQuote.map((entry) => [entry.quote_id, entry.id]));
  const contractByWarranty = new Map(warranties.map((entry) => [entry.id, entry.contract_id]));
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map(asPlain);
  const last = page.at(-1);
  logSensitiveAdminRead({ adminId: admin.id, jobId: job.id, resourceType: 'TRANSACTIONS', acceptanceCycle: cycle, correlationId });
  return {
    items: page.map((entry) => ({
      id: entry.id,
      acceptance_cycle: integer(entry.acceptance_cycle),
      transaction_type: entry.transaction_type,
      status: entry.status,
      amount: decimal(entry.amount),
      currency: entry.FromWallet?.currency || entry.ToWallet?.currency || 'VND',
      payment_method: entry.payment_method,
      description: entry.description,
      quote_id: entry.quote_id,
      contract_id: contractByWarranty.get(entry.warranty_id) || contractByQuote.get(entry.quote_id) || null,
      cancellation_id: entry.cancellation_id,
      completion_request_id: entry.completion_request_id,
      warranty_id: entry.warranty_id,
      warranty_completion_request_id: entry.warranty_completion_request_id,
      from: walletParty(entry.FromWallet, job),
      to: walletParty(entry.ToWallet, job),
      created_at: entry.createdAt,
      updated_at: entry.updatedAt
    })),
    has_more: hasMore,
    next_cursor: hasMore && last ? encodeCursor({ at: last.createdAt, id: last.id, fingerprint }) : null
  };
};

const getAdminJobEvidenceAccess = async ({ jobId, evidenceId, admin, correlationId }) => {
  const job = await loadJobOrThrow(jobId);
  assertUuid(evidenceId, 'evidenceId');
  const evidence = await EvidenceVault.findOne({ where: { id: evidenceId, job_id: job.id } });
  if (!evidence?.media_url) throw new AdminReviewError('Evidence was not found for this Job.', 404, 'ADMIN_JOB_EVIDENCE_NOT_FOUND');
  logSensitiveAdminRead({
    adminId: admin.id, jobId: job.id, resourceType: 'EVIDENCE',
    acceptanceCycle: evidence.acceptance_cycle, correlationId
  });
  return { url: evidence.media_url, expires_at: null, delivery: 'LEGACY_PUBLIC_AUTHORIZED_GATE' };
};

const getAdminJobImageAccess = async ({ jobId, imageKey, admin, correlationId }) => {
  const job = await loadJobOrThrow(jobId);
  if (!/^[0-9a-f]{32}$/i.test(String(imageKey || ''))) {
    throw new AdminReviewError('imageKey is invalid.', 400, 'VALIDATION_ERROR');
  }
  const url = (Array.isArray(job.images) ? job.images : []).find((entry) => typeof entry === 'string'
    && createHash('sha256').update(entry).digest('hex').slice(0, 32) === imageKey);
  if (!url) throw new AdminReviewError('Job image was not found.', 404, 'ADMIN_JOB_IMAGE_NOT_FOUND');
  logSensitiveAdminRead({ adminId: admin.id, jobId: job.id, resourceType: 'JOB_IMAGE', correlationId });
  return { url, expires_at: null, delivery: 'LEGACY_PUBLIC_AUTHORIZED_GATE' };
};

export {
  getAdminJobAudits,
  getAdminJobBids,
  getAdminJobChat,
  getAdminJobCycleDetail,
  getAdminJobCycles,
  getAdminJobDetail,
  getAdminJobEvidence,
  getAdminJobEvidenceAccess,
  getAdminJobImageAccess,
  getAdminJobTimeline,
  getAdminJobTransactions,
  getAdminJobs
};
