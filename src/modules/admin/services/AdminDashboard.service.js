import { Op, fn, col, literal, QueryTypes } from 'sequelize';
import db from '../../../core/database/connection.js';
import User from '../../identity/models/User.model.js';
import HandymanProfile from '../../identity/models/HandymanProfile.model.js';
import Job from '../../matchmaking/models/Job.model.js';
import Service from '../../matchmaking/models/Service.model.js';
import Wallet from '../../fintech/models/Wallet.model.js';
import Transaction from '../../fintech/models/Transaction.model.js';
import AdminAuditLog from '../models/AdminAuditLog.model.js';
import { parseVndInteger } from '../../matchmaking/utils/cancellationPolicy.util.js';
import { ADMIN_AUDIT_ACTIONS } from '../constants/admin.constants.js';
import { getAdminOperationalQueueSnapshot } from './AdminQueue.service.js';
import { presentAuditListItem } from './AdminAuditPresentation.service.js';
import { AdminManagementError } from '../utils/adminManagementValidation.util.js';

const TIMEZONE = 'Asia/Ho_Chi_Minh';
const UTC_PLUS_SEVEN_MS = 7 * 60 * 60 * 1000;
const PARTICIPANT_ROLES = ['CUSTOMER', 'HANDYMAN'];
const JOB_STATUSES = Job.rawAttributes.current_status.values || [];
const PERIODS = Object.freeze({
  '7D': { days: 7, granularity: 'DAY' },
  '30D': { days: 30, granularity: 'DAY' },
  '90D': { days: 90, granularity: 'DAY' },
  '12M': { months: 12, granularity: 'MONTH' }
});

const localParts = (date) => {
  const shifted = new Date(date.getTime() + UTC_PLUS_SEVEN_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate() };
};

const localBoundaryUtc = (year, month, day = 1) => new Date(Date.UTC(year, month, day) - UTC_PLUS_SEVEN_MS);

const resolvePeriod = (value, now = new Date()) => {
  const key = String(value || '30D').trim().toUpperCase();
  const definition = PERIODS[key];
  if (!definition) throw new AdminManagementError('period must be one of 7D, 30D, 90D or 12M.');
  const current = localParts(now);
  let startsAt;
  let endsAt;
  if (definition.months) {
    startsAt = localBoundaryUtc(current.year, current.month - definition.months + 1, 1);
    endsAt = localBoundaryUtc(current.year, current.month + 1, 1);
  } else {
    startsAt = localBoundaryUtc(current.year, current.month, current.day - definition.days + 1);
    endsAt = localBoundaryUtc(current.year, current.month, current.day + 1);
  }
  return { key, timezone: TIMEZONE, starts_at: startsAt, ends_at: endsAt, bucket_granularity: definition.granularity };
};

const bucketKeys = (period) => {
  const keys = [];
  const cursor = new Date(period.starts_at.getTime() + UTC_PLUS_SEVEN_MS);
  const end = new Date(period.ends_at.getTime() + UTC_PLUS_SEVEN_MS);
  while (cursor < end) {
    keys.push(period.bucket_granularity === 'MONTH'
      ? `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`
      : `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}-${String(cursor.getUTCDate()).padStart(2, '0')}`);
    if (period.bucket_granularity === 'MONTH') cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
};

const bucketSql = (modelAlias, granularity) => literal(
  `to_char(timezone('${TIMEZONE}', "${modelAlias}"."createdAt"), '${granularity === 'MONTH' ? 'YYYY-MM' : 'YYYY-MM-DD'}')`
);

const fillCountSeries = (keys, rows, valueField = 'count') => {
  const values = new Map(rows.map((row) => [String(row.bucket_key), Number(row[valueField] || 0)]));
  return keys.map((bucket) => ({ bucket, value: values.get(bucket) || 0 }));
};

const fillMoneySeries = (keys, rows) => {
  const values = new Map(rows.map((row) => {
    const parsed = parseVndInteger(row.amount || '0');
    if (!parsed.valid) throw new Error('Platform fee aggregate is not a valid VND integer.');
    return [String(row.bucket_key), parsed.amount.toString()];
  }));
  return keys.map((bucket) => ({ bucket, value: values.get(bucket) || '0' }));
};

const metricFromWallet = (wallet) => {
  if (!wallet) return { value: null, availability: 'UNAVAILABLE', reason_code: 'SYSTEM_WALLET_NOT_FOUND' };
  if (wallet.currency !== 'VND') return { value: null, availability: 'UNAVAILABLE', reason_code: 'UNSUPPORTED_CURRENCY' };
  const parsed = parseVndInteger(wallet.balance);
  return parsed.valid
    ? { value: parsed.amount.toString(), availability: 'AVAILABLE' }
    : { value: null, availability: 'UNAVAILABLE', reason_code: 'INVALID_VND_AMOUNT' };
};

const getInactiveParticipantsWithActiveJobs = async () => {
  const quote = db.getQueryInterface().queryGenerator;
  const jobs = quote.quoteTable(Job.getTableName());
  const users = quote.quoteTable(User.getTableName());
  const [row] = await db.query(`
    SELECT COUNT(DISTINCT active_participants.participant_id)::integer AS count
    FROM (
      SELECT "customer_id" AS participant_id FROM ${jobs}
      WHERE "current_status" NOT IN ('CLOSED', 'CANCELLED')
      UNION
      SELECT "selected_handyman_id" AS participant_id FROM ${jobs}
      WHERE "current_status" NOT IN ('CLOSED', 'CANCELLED') AND "selected_handyman_id" IS NOT NULL
    ) active_participants
    INNER JOIN ${users} participant ON participant.id = active_participants.participant_id
    WHERE participant.role IN ('CUSTOMER', 'HANDYMAN') AND participant.is_active = false
  `, { type: QueryTypes.SELECT });
  return Number(row?.count || 0);
};

const summarizeUsers = (allRows, newRows) => {
  const result = {
    total_customers: 0, total_handymen: 0, active_customers: 0, active_handymen: 0,
    inactive_users: 0, new_customers_in_period: 0, new_handymen_in_period: 0
  };
  allRows.forEach((row) => {
    const count = Number(row.count || 0);
    if (row.role === 'CUSTOMER') {
      result.total_customers += count;
      if (row.is_active) result.active_customers += count;
    }
    if (row.role === 'HANDYMAN') {
      result.total_handymen += count;
      if (row.is_active) result.active_handymen += count;
    }
    if (!row.is_active) result.inactive_users += count;
  });
  newRows.forEach((row) => {
    if (row.role === 'CUSTOMER') result.new_customers_in_period = Number(row.count || 0);
    if (row.role === 'HANDYMAN') result.new_handymen_in_period = Number(row.count || 0);
  });
  return result;
};

const statusDistribution = (rows) => {
  const counts = new Map(rows.map((row) => [row.current_status, Number(row.count || 0)]));
  return JOB_STATUSES.map((status) => ({ status, count: counts.get(status) || 0 }));
};

const recentActivity = async () => {
  const excludedActions = [ADMIN_AUDIT_ACTIONS.LOGIN_SUCCEEDED, ADMIN_AUDIT_ACTIONS.LOGOUT];
  const [jobs, users, audits] = await Promise.all([
    Job.findAll({
      attributes: ['id', 'issue_description', 'current_status', 'createdAt'],
      include: [{ model: Service, attributes: ['name'], required: false }],
      order: [['createdAt', 'DESC'], ['id', 'DESC']], limit: 12
    }),
    User.findAll({
      where: { role: { [Op.in]: PARTICIPANT_ROLES } },
      attributes: ['id', 'full_name', 'role', 'createdAt'],
      order: [['createdAt', 'DESC'], ['id', 'DESC']], limit: 12
    }),
    AdminAuditLog.findAll({
      where: { action: { [Op.notIn]: excludedActions } },
      attributes: ['id', 'action', 'target_type', 'target_id', 'reason_code', 'after_state', 'correlation_id', 'createdAt'],
      include: [{ model: User, as: 'Administrator', attributes: ['id', 'full_name', 'email'], required: false }],
      order: [['createdAt', 'DESC'], ['id', 'DESC']], limit: 20
    })
  ]);
  const items = [
    ...jobs.map((job) => ({
      id: `JOB:${job.id}`, activity_type: 'JOB_CREATED',
      summary: `New Job: ${[job.Service?.name, String(job.issue_description || '').slice(0, 70)].filter(Boolean).join(' — ')}`,
      actor: null, target: { type: 'JOB', id: job.id }, occurred_at: job.createdAt,
      destination: `/admin/jobs/${job.id}`
    })),
    ...users.map((user) => ({
      id: `USER:${user.id}`, activity_type: 'PARTICIPANT_REGISTERED',
      summary: `${user.role === 'HANDYMAN' ? 'Handyman' : 'Customer'} registered: ${user.full_name}`,
      actor: null, target: { type: 'USER_ACCOUNT', id: user.id }, occurred_at: user.createdAt,
      destination: `/admin/users/${user.id}`
    })),
    ...audits.map((audit) => {
      const item = presentAuditListItem(audit);
      return {
        id: `AUDIT:${item.audit_id}`, activity_type: item.action, summary: item.summary,
        actor: item.administrator ? { kind: 'ADMIN', ...item.administrator } : null,
        target: item.target, occurred_at: item.created_at,
        destination: item.target.destination || `/admin/audit/${item.audit_id}`
      };
    })
  ];
  return items.sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at) || String(b.id).localeCompare(String(a.id))).slice(0, 15);
};

const getAdminDashboard = async (query = {}) => {
  const period = resolvePeriod(query.period);
  const range = { [Op.gte]: period.starts_at, [Op.lt]: period.ends_at };
  const bucket = bucketSql;
  const keys = bucketKeys(period);
  const [
    allUsers, newUsers, kycStatusRows, handymanRows, allJobRows, periodJobRows,
    queueSnapshot, inactiveWithActiveJobs, systemWallets, feeAggregate, successfulTransactionCount,
    jobTimeRows, registrationTimeRows, feeTimeRows, activity
  ] = await Promise.all([
    User.findAll({
      where: { role: { [Op.in]: PARTICIPANT_ROLES } },
      attributes: ['role', 'is_active', [fn('COUNT', col('id')), 'count']],
      group: ['role', 'is_active'], raw: true
    }),
    User.findAll({
      where: { role: { [Op.in]: PARTICIPANT_ROLES }, createdAt: range },
      attributes: ['role', [fn('COUNT', col('id')), 'count']], group: ['role'], raw: true
    }),
    User.findAll({
      where: { role: { [Op.in]: PARTICIPANT_ROLES } },
      attributes: ['role', 'kyc_status', [fn('COUNT', col('id')), 'count']],
      group: ['role', 'kyc_status'], raw: true
    }),
    HandymanProfile.findAll({
      attributes: ['handyman_level', 'security_bond_status', [fn('COUNT', col('user_id')), 'count']],
      group: ['handyman_level', 'security_bond_status'], raw: true
    }),
    Job.findAll({ attributes: ['current_status', [fn('COUNT', col('id')), 'count']], group: ['current_status'], raw: true }),
    Job.findAll({
      where: { createdAt: range },
      attributes: ['current_status', [fn('COUNT', col('id')), 'count']], group: ['current_status'], raw: true
    }),
    getAdminOperationalQueueSnapshot(),
    getInactiveParticipantsWithActiveJobs(),
    Wallet.findAll({ where: { user_id: null, wallet_type: { [Op.in]: ['SYSTEM_ESCROW', 'SYSTEM_PROFIT'] } }, attributes: ['wallet_type', 'balance', 'currency'], raw: true }),
    Transaction.findOne({
      where: { transaction_type: 'PLATFORM_SERVICE_FEE', status: 'SUCCESS', createdAt: range },
      attributes: [[fn('SUM', col('amount')), 'amount']],
      include: [{ model: Wallet, as: 'ToWallet', required: true, attributes: [], where: { wallet_type: 'SYSTEM_PROFIT', currency: 'VND' } }],
      raw: true
    }),
    Transaction.count({ where: { status: 'SUCCESS', createdAt: range } }),
    Job.findAll({
      where: { createdAt: range },
      attributes: [[bucket('Job', period.bucket_granularity), 'bucket_key'], [fn('COUNT', col('id')), 'count']],
      group: [bucket('Job', period.bucket_granularity)], raw: true
    }),
    User.findAll({
      where: { role: { [Op.in]: PARTICIPANT_ROLES }, createdAt: range },
      attributes: ['role', [bucket('User', period.bucket_granularity), 'bucket_key'], [fn('COUNT', col('id')), 'count']],
      group: ['role', bucket('User', period.bucket_granularity)], raw: true
    }),
    Transaction.findAll({
      where: { transaction_type: 'PLATFORM_SERVICE_FEE', status: 'SUCCESS', createdAt: range },
      attributes: [[bucket('Transaction', period.bucket_granularity), 'bucket_key'], [fn('SUM', col('amount')), 'amount']],
      include: [{ model: Wallet, as: 'ToWallet', required: true, attributes: [], where: { wallet_type: 'SYSTEM_PROFIT', currency: 'VND' } }],
      group: [bucket('Transaction', period.bucket_granularity)], raw: true
    }),
    recentActivity()
  ]);

  const userMetrics = summarizeUsers(allUsers, newUsers);
  const allDistribution = statusDistribution(allJobRows);
  const periodDistribution = statusDistribution(periodJobRows);
  const totalJobs = allDistribution.reduce((sum, item) => sum + item.count, 0);
  const queue = queueSnapshot.counts;
  const feeParsed = parseVndInteger(feeAggregate?.amount || '0');
  if (!feeParsed.valid) throw new Error('Platform fee aggregate is not a valid VND integer.');
  const walletByType = new Map(systemWallets.map((wallet) => [wallet.wallet_type, wallet]));
  const levels = Object.fromEntries(['C0', 'C1', 'C2', 'C3'].map((level) => [level, 0]));
  let activeSecurityBonds = 0;
  handymanRows.forEach((row) => {
    levels[row.handyman_level] = (levels[row.handyman_level] || 0) + Number(row.count || 0);
    if (row.security_bond_status === 'PAID') activeSecurityBonds += Number(row.count || 0);
  });
  const verified = { CUSTOMER: 0, HANDYMAN: 0 };
  let rejected = 0;
  kycStatusRows.forEach((row) => {
    if (row.kyc_status === 'VERIFIED') verified[row.role] += Number(row.count || 0);
    if (row.kyc_status === 'REJECTED') rejected += Number(row.count || 0);
  });
  const customerRegistrationRows = registrationTimeRows.filter((row) => row.role === 'CUSTOMER');
  const handymanRegistrationRows = registrationTimeRows.filter((row) => row.role === 'HANDYMAN');

  return {
    generated_at: new Date().toISOString(),
    period: {
      key: period.key, timezone: period.timezone,
      starts_at: period.starts_at.toISOString(), ends_at: period.ends_at.toISOString(),
      bucket_granularity: period.bucket_granularity
    },
    users: userMetrics,
    trust_and_safety: {
      pending_kyc: queue.kyc_pending,
      rejected_participants: rejected,
      verified_customers: verified.CUSTOMER,
      verified_handymen: verified.HANDYMAN,
      handyman_level_distribution: levels,
      active_security_bonds: activeSecurityBonds
    },
    jobs: {
      total_jobs: totalJobs,
      active_jobs: allDistribution.filter((item) => !['CLOSED', 'CANCELLED'].includes(item.status)).reduce((sum, item) => sum + item.count, 0),
      closed_jobs: allDistribution.find((item) => item.status === 'CLOSED')?.count || 0,
      cancelled_jobs: allDistribution.find((item) => item.status === 'CANCELLED')?.count || 0,
      jobs_created_in_period: periodDistribution.reduce((sum, item) => sum + item.count, 0),
      distinct_jobs_needing_review: queueSnapshot.distinct_jobs_needing_review,
      pending_review_cases: {
        total_cases: queue.review_pending_total,
        warranty_claim_cases: queue.warranty_claim_pending,
        warranty_rework_cases: queue.warranty_rework_review_required,
        cancellation_cases: queue.cancellation_review_required
      },
      all_time_status_distribution: allDistribution,
      created_in_period_current_status_distribution: periodDistribution
    },
    finance: {
      currency: 'VND',
      system_escrow_balance: metricFromWallet(walletByType.get('SYSTEM_ESCROW')),
      system_profit_balance: metricFromWallet(walletByType.get('SYSTEM_PROFIT')),
      successful_platform_fee_in_period: {
        value: feeParsed.amount.toString(), availability: 'AVAILABLE',
        included_transaction_types: ['PLATFORM_SERVICE_FEE']
      },
      successful_transaction_count_in_period: Number(successfulTransactionCount || 0),
      warranty_reserve_held: {
        value: null, availability: 'UNAVAILABLE', reason_code: 'GLOBAL_RECONCILIATION_NOT_AVAILABLE'
      }
    },
    action_queue: [
      { type: 'PENDING_KYC', count: queue.kyc_pending, unit: 'submissions', severity: 'HIGH', description: 'Identity submissions awaiting review.', destination: '/admin/kyc' },
      { type: 'WARRANTY_CLAIM_CASES', count: queue.warranty_claim_pending, unit: 'cases', severity: 'HIGH', description: 'Warranty Claims awaiting an Admin decision.', destination: '/admin/jobs?needs_review=true&review_type=WARRANTY_CLAIM' },
      { type: 'WARRANTY_REWORK_CASES', count: queue.warranty_rework_review_required, unit: 'cases', severity: 'HIGH', description: 'Rejected rework requests awaiting review.', destination: '/admin/jobs?needs_review=true&review_type=WARRANTY_REWORK' },
      { type: 'CANCELLATION_CASES', count: queue.cancellation_review_required, unit: 'cases', severity: 'HIGH', description: 'Cancellation disputes awaiting resolution.', destination: '/admin/jobs?needs_review=true&review_type=CANCELLATION' },
      { type: 'DISTINCT_JOBS_NEEDING_REVIEW', count: queueSnapshot.distinct_jobs_needing_review, unit: 'jobs', severity: 'HIGH', description: 'Distinct Jobs with one or more pending review cases.', destination: '/admin/jobs?needs_review=true' },
      { type: 'INACTIVE_PARTICIPANTS_WITH_ACTIVE_JOBS', count: inactiveWithActiveJobs, unit: 'participants', severity: 'MEDIUM', description: 'Inactive participants still linked to active Jobs.', destination: '/admin/users?is_active=false' }
    ],
    charts: {
      jobs_created_over_time: fillCountSeries(keys, jobTimeRows),
      jobs_created_in_period_by_current_status: periodDistribution,
      participant_registrations_over_time: {
        customers: fillCountSeries(keys, customerRegistrationRows),
        handymen: fillCountSeries(keys, handymanRegistrationRows)
      },
      successful_platform_fees_over_time: { currency: 'VND', points: fillMoneySeries(keys, feeTimeRows) }
    },
    recent_activity: activity
  };
};

export { getAdminDashboard, resolvePeriod };
