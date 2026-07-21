import { Op, fn, col, literal } from 'sequelize';
import db from '../../../core/database/connection.js';
import User from '../../identity/models/User.model.js';
import UserAddress from '../../identity/models/UserAddress.model.js';
import HandymanProfile from '../../identity/models/HandymanProfile.model.js';
import KycRequest from '../../identity/models/KycRequest.model.js';
import RefreshToken from '../../identity/models/RefreshToken.model.js';
import Service from '../../matchmaking/models/Service.model.js';
import HandymanService from '../../matchmaking/models/HandymanService.model.js';
import HandymanServiceArea from '../../matchmaking/models/HandymanServiceArea.model.js';
import Province from '../../matchmaking/models/Province.model.js';
import Ward from '../../matchmaking/models/Ward.model.js';
import Job from '../../matchmaking/models/Job.model.js';
import JobWarranty from '../../matchmaking/models/JobWarranty.model.js';
import WarrantyClaim from '../../matchmaking/models/WarrantyClaim.model.js';
import Review from '../../dispute/models/Review.model.js';
import Wallet from '../../fintech/models/Wallet.model.js';
import Transaction from '../../fintech/models/Transaction.model.js';
import AdminAuditLog from '../models/AdminAuditLog.model.js';
import { createAdminAuditLog } from './AdminAudit.service.js';
import { ADMIN_AUDIT_ACTIONS, ADMIN_AUDIT_TARGETS } from '../constants/admin.constants.js';
import { logSensitiveAdminRead } from './AdminSecurityReadLog.service.js';
import {
  ACCOUNT_ACTIONS,
  ACCOUNT_REASON_CODES,
  PARTICIPANT_ROLES,
  buildAccountDecisionRequirements
} from '../constants/adminManagement.constants.js';
import {
  AdminManagementError,
  assertUuid,
  normalizePlainText,
  normalizeSearch,
  parseBoolean,
  parseDate,
  parsePositiveInteger
} from '../utils/adminManagementValidation.util.js';

const USER_SORTS = Object.freeze({
  CREATED_DESC: [['createdAt', 'DESC'], ['id', 'DESC']],
  CREATED_ASC: [['createdAt', 'ASC'], ['id', 'ASC']],
  UPDATED_DESC: [['updatedAt', 'DESC'], ['id', 'DESC']],
  UPDATED_ASC: [['updatedAt', 'ASC'], ['id', 'ASC']],
  NAME_ASC: [['full_name', 'ASC'], ['id', 'ASC']],
  NAME_DESC: [['full_name', 'DESC'], ['id', 'DESC']]
});
const ACCOUNT_AUDIT_VALUES = Object.freeze([ADMIN_AUDIT_ACTIONS.USER_DEACTIVATED, ADMIN_AUDIT_ACTIONS.USER_REACTIVATED]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const asPlain = (record) => record?.get ? record.get({ plain: true }) : record;
const decimal = (value) => value == null ? '0.00' : String(value);

const normalizeUserFilters = async (query = {}) => {
  const role = String(query.role || 'ALL').trim().toUpperCase();
  if (![...PARTICIPANT_ROLES, 'ALL'].includes(role)) throw new AdminManagementError('role is invalid.');
  const kycStatus = String(query.kyc_status || 'ALL').trim().toUpperCase();
  if (!['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED', 'ALL'].includes(kycStatus)) {
    throw new AdminManagementError('kyc_status is invalid.');
  }
  const handymanLevel = String(query.handyman_level || 'ALL').trim().toUpperCase();
  if (!['C0', 'C1', 'C2', 'C3', 'ALL'].includes(handymanLevel)) {
    throw new AdminManagementError('handyman_level is invalid.');
  }
  const bondStatus = String(query.security_bond_status || 'ALL').trim().toUpperCase();
  if (!['UNPAID', 'PAID', 'REFUNDED', 'ALL'].includes(bondStatus)) {
    throw new AdminManagementError('security_bond_status is invalid.');
  }
  const sort = String(query.sort || 'CREATED_DESC').trim().toUpperCase();
  if (!USER_SORTS[sort]) throw new AdminManagementError('sort is invalid.');
  const createdFrom = parseDate(query.created_from, 'created_from');
  const createdTo = parseDate(query.created_to, 'created_to', true);
  if (createdFrom && createdTo && createdFrom > createdTo) throw new AdminManagementError('created_from must precede created_to.');
  return {
    page: parsePositiveInteger(query.page, 'page', 1, Number.MAX_SAFE_INTEGER),
    pageSize: parsePositiveInteger(query.page_size, 'page_size', 20, 100),
    search: normalizeSearch(query.search),
    role,
    isActive: parseBoolean(query.is_active, 'is_active'),
    emailVerified: parseBoolean(query.email_verified, 'email_verified'),
    kycStatus,
    handymanLevel,
    bondStatus,
    createdFrom,
    createdTo,
    sort
  };
};

const buildUserWhere = async (filters) => {
  const where = { role: filters.role === 'ALL' ? { [Op.in]: PARTICIPANT_ROLES } : filters.role };
  if (filters.isActive !== null) where.is_active = filters.isActive;
  if (filters.emailVerified !== null) where.is_email_verified = filters.emailVerified;
  if (filters.kycStatus !== 'ALL') where.kyc_status = filters.kycStatus;
  if (filters.createdFrom || filters.createdTo) {
    where.createdAt = {
      ...(filters.createdFrom ? { [Op.gte]: filters.createdFrom } : {}),
      ...(filters.createdTo ? { [Op.lte]: filters.createdTo } : {})
    };
  }
  if (filters.search) {
    const clauses = [
      { full_name: { [Op.iLike]: `%${filters.search}%` } },
      { email: { [Op.iLike]: `%${filters.search}%` } },
      { phone_number: { [Op.iLike]: `%${filters.search}%` } }
    ];
    if (UUID_PATTERN.test(filters.search)) clauses.unshift({ id: filters.search });
    where[Op.or] = clauses;
  }
  if (filters.handymanLevel !== 'ALL' || filters.bondStatus !== 'ALL') {
    if (filters.role === 'CUSTOMER') {
      where.id = { [Op.in]: [] };
      return where;
    }
    const profileWhere = {
      ...(filters.handymanLevel !== 'ALL' ? { handyman_level: filters.handymanLevel } : {}),
      ...(filters.bondStatus !== 'ALL' ? { security_bond_status: filters.bondStatus } : {})
    };
    const profileIds = await HandymanProfile.findAll({ where: profileWhere, attributes: ['user_id'], raw: true });
    where.id = { [Op.in]: profileIds.map((entry) => entry.user_id) };
    if (filters.role === 'ALL') where.role = 'HANDYMAN';
  }
  return where;
};

const getJobCountsForUsers = async (userIds) => {
  if (!userIds.length) return new Map();
  const attributes = (ownerField) => [
    ownerField,
    [fn('COUNT', col('id')), 'total'],
    [fn('SUM', literal(`CASE WHEN "current_status" NOT IN ('CLOSED','CANCELLED') THEN 1 ELSE 0 END`)), 'active'],
    [fn('SUM', literal(`CASE WHEN "current_status" = 'CLOSED' THEN 1 ELSE 0 END`)), 'closed'],
    [fn('SUM', literal(`CASE WHEN "current_status" = 'CANCELLED' THEN 1 ELSE 0 END`)), 'cancelled']
  ];
  const [customerRows, handymanRows] = await Promise.all([
    Job.findAll({ attributes: attributes('customer_id'), where: { customer_id: { [Op.in]: userIds } }, group: ['customer_id'], raw: true }),
    Job.findAll({ attributes: attributes('selected_handyman_id'), where: { selected_handyman_id: { [Op.in]: userIds } }, group: ['selected_handyman_id'], raw: true })
  ]);
  const result = new Map();
  const put = (id, row) => result.set(id, {
    total: Number(row.total || 0), active: Number(row.active || 0),
    closed: Number(row.closed || 0), cancelled: Number(row.cancelled || 0)
  });
  customerRows.forEach((row) => put(row.customer_id, row));
  handymanRows.forEach((row) => put(row.selected_handyman_id, row));
  return result;
};

const getRatingSummaries = async (userIds) => {
  if (!userIds.length) return new Map();
  const rows = await Review.findAll({
    attributes: ['reviewee_id', [fn('AVG', col('rating_stars')), 'average'], [fn('COUNT', col('id')), 'count']],
    where: { reviewee_id: { [Op.in]: userIds } }, group: ['reviewee_id'], raw: true
  });
  return new Map(rows.map((row) => [row.reviewee_id, {
    average: Number(row.average || 0).toFixed(1), count: Number(row.count || 0)
  }]));
};

const hydrateUserPage = async (users) => {
  const plainUsers = users.map(asPlain);
  const ids = plainUsers.map((entry) => entry.id);
  if (!ids.length) return [];
  const [profiles, wallets, jobs, ratings, audits] = await Promise.all([
    HandymanProfile.findAll({ where: { user_id: { [Op.in]: ids } }, raw: true }),
    Wallet.findAll({ where: { user_id: { [Op.in]: ids } }, attributes: ['user_id', 'wallet_type', 'balance', 'currency', 'is_blocked'], raw: true }),
    getJobCountsForUsers(ids),
    getRatingSummaries(ids),
    AdminAuditLog.findAll({
      where: { target_type: ADMIN_AUDIT_TARGETS.USER_ACCOUNT, target_id: { [Op.in]: ids }, action: { [Op.in]: ACCOUNT_AUDIT_VALUES } },
      attributes: ['target_id', 'action', 'createdAt'], order: [['createdAt', 'DESC'], ['id', 'DESC']], raw: true
    })
  ]);
  const profileByUser = new Map(profiles.map((entry) => [entry.user_id, entry]));
  const walletsByUser = new Map();
  wallets.forEach((entry) => {
    if (!walletsByUser.has(entry.user_id)) walletsByUser.set(entry.user_id, []);
    walletsByUser.get(entry.user_id).push({
      wallet_type: entry.wallet_type, currency: entry.currency,
      available_balance: decimal(entry.balance), status: entry.is_blocked ? 'BLOCKED' : 'ACTIVE'
    });
  });
  const latestAudit = new Map();
  audits.forEach((entry) => { if (!latestAudit.has(entry.target_id)) latestAudit.set(entry.target_id, entry); });
  return plainUsers.map((user) => {
    const jobCounts = jobs.get(user.id) || { total: 0, active: 0, closed: 0, cancelled: 0 };
    const profile = profileByUser.get(user.id);
    const rating = ratings.get(user.id) || { average: '0.0', count: 0 };
    const lastAction = latestAudit.get(user.id);
    return {
      user_id: user.id, full_name: user.full_name, email: user.email,
      phone_number: user.phone_number || null, avatar_url: user.avatar_url || null,
      role: user.role, is_active: Boolean(user.is_active),
      email_verified: Boolean(user.is_email_verified), kyc_status: user.kyc_status,
      created_at: user.createdAt, updated_at: user.updatedAt,
      handyman: user.role === 'HANDYMAN' ? {
        level: profile?.handyman_level || 'C0', security_bond_status: profile?.security_bond_status || 'UNPAID'
      } : null,
      rating, job_counts: jobCounts, wallets: walletsByUser.get(user.id) || [],
      active_job_warning: jobCounts.active > 0,
      latest_account_action: lastAction ? { action: lastAction.action, occurred_at: lastAction.createdAt } : null
    };
  });
};

const getAdminUsers = async (query = {}) => {
  const filters = await normalizeUserFilters(query);
  const where = await buildUserWhere(filters);
  const { rows, count } = await User.findAndCountAll({
    where,
    attributes: ['id', 'full_name', 'email', 'phone_number', 'avatar_url', 'role', 'is_active', 'is_email_verified', 'kyc_status', 'createdAt', 'updatedAt'],
    order: USER_SORTS[filters.sort], limit: filters.pageSize, offset: (filters.page - 1) * filters.pageSize
  });
  return {
    items: await hydrateUserPage(rows),
    pagination: {
      page: filters.page, page_size: filters.pageSize, total_items: count,
      total_pages: Math.ceil(count / filters.pageSize)
    }
  };
};

const loadParticipant = async (userId, options = {}) => {
  assertUuid(userId, 'userId');
  const user = await User.findByPk(userId, options);
  if (!user) throw new AdminManagementError('User was not found.', 404, 'ADMIN_USER_NOT_FOUND');
  if (!PARTICIPANT_ROLES.includes(user.role)) {
    throw new AdminManagementError('Administrator accounts cannot be managed here.', 403, 'ADMIN_USER_TARGET_FORBIDDEN');
  }
  return user;
};

const getActiveJobImpact = async (user, transaction = null) => {
  const ownership = user.role === 'CUSTOMER' ? { customer_id: user.id } : { selected_handyman_id: user.id };
  const activeJobs = await Job.findAll({
    where: { ...ownership, current_status: { [Op.notIn]: ['CLOSED', 'CANCELLED'] } },
    attributes: ['id', 'current_status', 'service_id', 'updatedAt'],
    include: [{ model: Service, attributes: ['name'], required: false }],
    order: [['updatedAt', 'DESC'], ['id', 'DESC']],
    transaction
  });
  const byStatus = {};
  activeJobs.forEach((entry) => { byStatus[entry.current_status] = (byStatus[entry.current_status] || 0) + 1; });
  const ids = activeJobs.map((entry) => entry.id);
  let pendingReviewJobs = 0;
  if (ids.length) {
    const [claimRows, warrantyRows] = await Promise.all([
      WarrantyClaim.findAll({ where: { job_id: { [Op.in]: ids }, status: { [Op.in]: ['PENDING_REVIEW', 'REVIEW_REQUIRED'] } }, attributes: ['job_id'], raw: true, transaction }),
      JobWarranty.findAll({ where: { job_id: { [Op.in]: ids }, status: 'REVIEW_REQUIRED' }, attributes: ['job_id'], raw: true, transaction })
    ]);
    pendingReviewJobs = new Set([
      ...activeJobs.filter((entry) => entry.current_status === 'CANCELLATION_REVIEW').map((entry) => entry.id),
      ...claimRows.map((entry) => entry.job_id), ...warrantyRows.map((entry) => entry.job_id)
    ]).size;
  }
  return {
    active_job_count: activeJobs.length,
    active_jobs_by_status: byStatus,
    active_created_jobs: user.role === 'CUSTOMER' ? activeJobs.length : 0,
    active_assigned_jobs: user.role === 'HANDYMAN' ? activeJobs.length : 0,
    active_warranty_jobs: activeJobs.filter((entry) => entry.current_status === 'WARRANTY').length,
    pending_review_jobs: pendingReviewJobs,
    representative_jobs: activeJobs.slice(0, 5).map((entry) => ({
      job_id: entry.id, status: entry.current_status, service_name: entry.Service?.name || null, updated_at: entry.updatedAt
    }))
  };
};

const buildKycSummary = (documents) => {
  const submissions = new Map();
  documents.filter((entry) => entry.submission_id).forEach((entry) => {
    if (!submissions.has(entry.submission_id)) submissions.set(entry.submission_id, {
      submission_id: entry.submission_id,
      submission_sequence: entry.submission_sequence,
      status: entry.status,
      submitted_at: entry.createdAt,
      reviewed_at: entry.reviewed_at,
      reviewer: entry.Admin ? { user_id: entry.Admin.id, full_name: entry.Admin.full_name } : null,
      rejection_reason_code: entry.rejection_reason_code,
      rejection_reason_text: entry.rejection_reason_text,
      documents: []
    });
    submissions.get(entry.submission_id).documents.push({
      document_id: entry.id, document_type: entry.document_type,
      mime_type: entry.document_mime_type, uploaded_at: entry.createdAt,
      can_view: Boolean(entry.cloudinary_public_id)
    });
  });
  const history = [...submissions.values()].sort((a, b) => b.submission_sequence - a.submission_sequence).slice(0, 20);
  return { latest_submission: history[0] || null, history, has_more: submissions.size > history.length };
};

const getWalletLedgerStats = async (wallets) => {
  const ids = wallets.map((entry) => entry.id);
  if (!ids.length) return new Map();
  const aggregate = async (field) => Transaction.findAll({
    attributes: [field,
      [fn('SUM', literal(`CASE WHEN "status" = 'SUCCESS' THEN "amount" ELSE 0 END`)), 'successful_amount'],
      [fn('COUNT', col('id')), 'count'],
      [fn('SUM', literal(`CASE WHEN "status" = 'PENDING' THEN 1 ELSE 0 END`)), 'pending_count'],
      [fn('SUM', literal(`CASE WHEN "status" = 'FAILED' THEN 1 ELSE 0 END`)), 'failed_count'],
      [fn('MAX', col('createdAt')), 'last_transaction_at']],
    where: { [field]: { [Op.in]: ids } }, group: [field], raw: true
  });
  const [incoming, outgoing] = await Promise.all([aggregate('to_wallet_id'), aggregate('from_wallet_id')]);
  const result = new Map(ids.map((id) => [id, { total_incoming: '0.00', total_outgoing: '0.00', transaction_count: 0, pending_count: 0, failed_count: 0, last_transaction_at: null }]));
  incoming.forEach((entry) => Object.assign(result.get(entry.to_wallet_id), {
    total_incoming: decimal(entry.successful_amount),
    transaction_count: Number(entry.count || 0), pending_count: Number(entry.pending_count || 0),
    failed_count: Number(entry.failed_count || 0), last_transaction_at: entry.last_transaction_at
  }));
  outgoing.forEach((entry) => {
    const current = result.get(entry.from_wallet_id);
    current.total_outgoing = decimal(entry.successful_amount);
    current.transaction_count += Number(entry.count || 0);
    current.pending_count += Number(entry.pending_count || 0);
    current.failed_count += Number(entry.failed_count || 0);
    if (!current.last_transaction_at || new Date(entry.last_transaction_at) > new Date(current.last_transaction_at)) current.last_transaction_at = entry.last_transaction_at;
  });
  return result;
};

const getAccountHistory = async (userId) => {
  const audits = await AdminAuditLog.findAll({
    where: { target_type: ADMIN_AUDIT_TARGETS.USER_ACCOUNT, target_id: userId, action: { [Op.in]: ACCOUNT_AUDIT_VALUES } },
    attributes: ['id', 'admin_id', 'action', 'reason_code', 'reason_text', 'before_state', 'after_state', 'correlation_id', 'createdAt'],
    order: [['createdAt', 'DESC'], ['id', 'DESC']], limit: 100
  });
  const adminIds = [...new Set(audits.map((entry) => entry.admin_id))];
  const admins = adminIds.length ? await User.findAll({ where: { id: { [Op.in]: adminIds } }, attributes: ['id', 'full_name'], raw: true }) : [];
  const adminById = new Map(admins.map((entry) => [entry.id, entry]));
  return audits.map((entry) => ({
    action: entry.action,
    administrator: adminById.get(entry.admin_id) || { id: entry.admin_id, full_name: 'Administrator' },
    reason_code: entry.reason_code, reason_text: entry.reason_text,
    previous_is_active: entry.before_state?.is_active,
    new_is_active: entry.after_state?.is_active,
    correlation_id: entry.correlation_id, occurred_at: entry.createdAt
  }));
};

const getAdminUserDetail = async ({ userId, admin, correlationId }) => {
  const user = await loadParticipant(userId);
  const ownership = user.role === 'CUSTOMER' ? { customer_id: user.id } : { selected_handyman_id: user.id };
  const [profile, addresses, handymanServices, areas, kycDocuments, jobs, wallets, recentRatings, ratingAggregate, ratingDistribution, accountHistory, activeImpact] = await Promise.all([
    user.role === 'HANDYMAN' ? HandymanProfile.findOne({ where: { user_id: user.id }, raw: true }) : null,
    UserAddress.findAll({
      where: { user_id: user.id }, attributes: ['id', 'province_code', 'ward_code', 'detail_address', 'full_address', 'is_default', 'createdAt', 'updatedAt'],
      include: [{ model: Province, attributes: ['name'], required: false }, { model: Ward, attributes: ['name'], required: false }],
      order: [['is_default', 'DESC'], ['createdAt', 'DESC']]
    }),
    user.role === 'HANDYMAN' ? HandymanService.findAll({ where: { handyman_id: user.id }, attributes: ['service_id'], include: [{ model: Service, attributes: ['id', 'service_code', 'name', 'icon_url', 'is_active'] }] }) : [],
    user.role === 'HANDYMAN' ? HandymanServiceArea.findAll({ where: { handyman_id: user.id }, attributes: ['id', 'province_code', 'ward_code'], include: [{ model: Province, attributes: ['name'], required: false }, { model: Ward, attributes: ['name'], required: false }] }) : [],
    KycRequest.findAll({ where: { user_id: user.id, submission_id: { [Op.ne]: null } }, attributes: ['id', 'submission_id', 'submission_sequence', 'document_type', 'document_mime_type', 'cloudinary_public_id', 'status', 'rejection_reason_code', 'rejection_reason_text', 'reviewed_at', 'createdAt'], include: [{ model: User, as: 'Admin', attributes: ['id', 'full_name'], required: false }], order: [['submission_sequence', 'DESC'], ['document_type', 'ASC']] }),
    Job.findAll({ where: ownership, attributes: ['id', 'current_status', 'issue_description', 'createdAt', 'updatedAt'], include: [{ model: Service, attributes: ['name'], required: false }], order: [['updatedAt', 'DESC'], ['id', 'DESC']], limit: 10 }),
    Wallet.findAll({ where: { user_id: user.id }, attributes: ['id', 'wallet_type', 'balance', 'currency', 'is_blocked', 'createdAt', 'updatedAt'], order: [['wallet_type', 'ASC']] }),
    Review.findAll({ where: { reviewee_id: user.id }, attributes: ['id', 'job_id', 'rating_stars', 'is_job_successful', 'comment', 'createdAt'], order: [['createdAt', 'DESC'], ['id', 'DESC']], limit: 10 }),
    Review.findOne({ where: { reviewee_id: user.id }, attributes: [[fn('COUNT', col('id')), 'count'], [fn('AVG', col('rating_stars')), 'average']], raw: true }),
    Review.findAll({ where: { reviewee_id: user.id }, attributes: ['rating_stars', [fn('COUNT', col('id')), 'count']], group: ['rating_stars'], raw: true }),
    getAccountHistory(user.id),
    getActiveJobImpact(user)
  ]);
  const walletStats = await getWalletLedgerStats(wallets);
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  ratingDistribution.forEach((entry) => { distribution[entry.rating_stars] = Number(entry.count || 0); });
  const ratingCount = Number(ratingAggregate?.count || 0);
  const average = ratingCount ? Number(ratingAggregate.average || 0).toFixed(1) : '0.0';
  const jobCounts = (await getJobCountsForUsers([user.id])).get(user.id) || { total: 0, active: 0, closed: 0, cancelled: 0 };
  logSensitiveAdminRead({ adminId: admin.id, userId: user.id, resourceType: 'USER_DETAIL', correlationId });
  const action = user.is_active ? ACCOUNT_ACTIONS.DEACTIVATE : ACCOUNT_ACTIONS.REACTIVATE;
  return {
    overview: {
      user_id: user.id, full_name: user.full_name, email: user.email, phone_number: user.phone_number || null,
      avatar_url: user.avatar_url || null, role: user.role, is_active: Boolean(user.is_active),
      email_verified: Boolean(user.is_email_verified), kyc_status: user.kyc_status,
      created_at: user.createdAt, updated_at: user.updatedAt
    },
    profile: user.role === 'HANDYMAN' ? {
      bio: profile?.bio || null, handyman_level: profile?.handyman_level || 'C0',
      security_bond_status: profile?.security_bond_status || 'UNPAID',
      preferred_work_times: profile?.preferred_work_times || [], total_jobs_completed: profile?.total_jobs_completed || 0,
      services: handymanServices.map((entry) => asPlain(entry).Service).filter(Boolean),
      service_areas: areas.map((entry) => ({ id: entry.id, province_code: entry.province_code, province_name: entry.Province?.name || null, ward_code: entry.ward_code, ward_name: entry.Ward?.name || null }))
    } : null,
    addresses: addresses.map((entry) => ({ id: entry.id, province_code: entry.province_code, province_name: entry.Province?.name || null, ward_code: entry.ward_code, ward_name: entry.Ward?.name || null, detail_address: entry.detail_address, full_address: entry.full_address, is_default: entry.is_default })),
    kyc: { current_status: user.kyc_status, ...buildKycSummary(kycDocuments) },
    job_summary: jobCounts,
    recent_jobs: jobs.map((entry) => ({ job_id: entry.id, status: entry.current_status, service_name: entry.Service?.name || null, issue_summary: String(entry.issue_description || '').slice(0, 100), created_at: entry.createdAt, updated_at: entry.updatedAt })),
    wallets: wallets.map((entry) => ({ wallet_type: entry.wallet_type, currency: entry.currency, available_balance: decimal(entry.balance), status: entry.is_blocked ? 'BLOCKED' : 'ACTIVE', ...walletStats.get(entry.id) })),
    ratings: { average, count: ratingCount, distribution, recent: recentRatings.map((entry) => ({ review_id: entry.id, job_id: entry.job_id, rating_stars: entry.rating_stars, is_job_successful: entry.is_job_successful, comment: entry.comment, created_at: entry.createdAt })) },
    account_status_history: accountHistory,
    active_job_impact: activeImpact,
    allowed_admin_actions: [action],
    decision_requirements: { [action]: buildAccountDecisionRequirements(action) }
  };
};

const getAdminUserJobs = async ({ userId, query = {} }) => {
  const user = await loadParticipant(userId);
  const page = parsePositiveInteger(query.page, 'page', 1, Number.MAX_SAFE_INTEGER);
  const pageSize = parsePositiveInteger(query.page_size, 'page_size', 20, 100);
  const status = String(query.status || 'ALL').trim().toUpperCase();
  const validStatuses = Job.rawAttributes.current_status.values || [];
  if (status !== 'ALL' && !validStatuses.includes(status)) throw new AdminManagementError('status is invalid.');
  const where = {
    ...(user.role === 'CUSTOMER' ? { customer_id: user.id } : { selected_handyman_id: user.id }),
    ...(status !== 'ALL' ? { current_status: status } : {})
  };
  const { rows, count } = await Job.findAndCountAll({ where, attributes: ['id', 'current_status', 'issue_description', 'createdAt', 'updatedAt'], include: [{ model: Service, attributes: ['name'], required: false }], order: [['createdAt', 'DESC'], ['id', 'DESC']], limit: pageSize, offset: (page - 1) * pageSize, distinct: true });
  return { items: rows.map((entry) => ({ job_id: entry.id, status: entry.current_status, service_name: entry.Service?.name || null, issue_summary: String(entry.issue_description || '').slice(0, 100), created_at: entry.createdAt, updated_at: entry.updatedAt })), pagination: { page, page_size: pageSize, total_items: count, total_pages: Math.ceil(count / pageSize) } };
};

const validateAccountPayload = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new AdminManagementError('Request body must be an object.');
  const unknown = Object.keys(payload).filter((key) => !['reason_code', 'reason_text'].includes(key));
  if (unknown.length) throw new AdminManagementError(`Unsupported fields: ${unknown.join(', ')}.`);
  const reasonCode = String(payload.reason_code || '').trim().toUpperCase();
  if (!ACCOUNT_REASON_CODES.includes(reasonCode)) throw new AdminManagementError('reason_code is invalid.', 400, 'ACCOUNT_REASON_INVALID');
  const reasonText = normalizePlainText(payload.reason_text, 'reason_text', 500, { required: reasonCode === 'OTHER' });
  return { reasonCode, reasonText };
};

const changeAccountStatus = async ({ userId, activate, admin, payload, requestMeta }, attempt = 0) => {
  assertUuid(userId, 'userId');
  const { reasonCode, reasonText } = validateAccountPayload(payload);
  const transaction = await db.transaction();
  try {
    const user = await loadParticipant(userId, { transaction, lock: transaction.LOCK.UPDATE });
    if (Boolean(user.is_active) === activate) {
      throw new AdminManagementError(`Account is already ${activate ? 'active' : 'inactive'}.`, 409, 'ACCOUNT_STATUS_ALREADY_SET');
    }
    const impact = await getActiveJobImpact(user, transaction);
    const beforeVersion = Number(user.auth_version || 0);
    const nextVersion = activate ? beforeVersion : beforeVersion + 1;
    await user.update({ is_active: activate, auth_version: nextVersion }, { transaction });
    if (!activate) await RefreshToken.update({ is_revoked: true }, { where: { user_id: user.id, is_revoked: false }, transaction });
    await createAdminAuditLog({
      adminId: admin.id,
      action: activate ? ADMIN_AUDIT_ACTIONS.USER_REACTIVATED : ADMIN_AUDIT_ACTIONS.USER_DEACTIVATED,
      targetType: ADMIN_AUDIT_TARGETS.USER_ACCOUNT,
      targetId: user.id,
      reasonCode,
      reasonText,
      beforeState: { user_id: user.id, user_role: user.role, is_active: !activate, auth_version: beforeVersion, active_job_count: impact.active_job_count, active_jobs_by_status: impact.active_jobs_by_status, active_created_jobs: impact.active_created_jobs, active_assigned_jobs: impact.active_assigned_jobs, active_warranty_jobs: impact.active_warranty_jobs, pending_review_jobs: impact.pending_review_jobs },
      afterState: { user_id: user.id, user_role: user.role, is_active: activate, auth_version: nextVersion },
      correlationId: requestMeta.correlationId,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      transaction
    });
    await transaction.commit();
    return {
      user: { user_id: user.id, full_name: user.full_name, role: user.role, is_active: activate },
      auth_version_changed: nextVersion !== beforeVersion,
      active_job_impact: impact
    };
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    if ((error?.original?.code === '40P01' || error?.parent?.code === '40P01') && attempt < 2) {
      return changeAccountStatus({ userId, activate, admin, payload, requestMeta }, attempt + 1);
    }
    throw error;
  }
};

export {
  getAdminUserDetail,
  getAdminUserJobs,
  getAdminUsers,
  changeAccountStatus
};
