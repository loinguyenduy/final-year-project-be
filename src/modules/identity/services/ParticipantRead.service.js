import { Op, fn, col } from 'sequelize';
import User from '../models/User.model.js';
import UserAddress from '../models/UserAddress.model.js';
import HandymanProfile from '../models/HandymanProfile.model.js';
import AuthProvider from '../models/AuthProvider.model.js';
import KycRequest from '../models/KycRequest.model.js';
import Wallet from '../../fintech/models/Wallet.model.js';
import Job from '../../matchmaking/models/Job.model.js';
import Bid from '../../matchmaking/models/Bid.model.js';
import Service from '../../matchmaking/models/Service.model.js';
import HandymanService from '../../matchmaking/models/HandymanService.model.js';
import HandymanServiceArea from '../../matchmaking/models/HandymanServiceArea.model.js';
import Province from '../../matchmaking/models/Province.model.js';
import Ward from '../../matchmaking/models/Ward.model.js';
import { getMyWallets } from '../../fintech/services/TransactionRead.service.js';
import { getRatingSummary } from '../../dispute/services/Rating.service.js';
import { getReviewStateMap } from '../../dispute/services/Review.service.js';
import { KYC_REJECTION_MESSAGES } from '../constants/kyc.constants.js';

const ACTIVE_STATUSES = ['POSTED', 'BIDDING', 'PENDING_DEPOSIT', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'QUOTE_PENDING', 'PAYMENT_PENDING', 'CANCELLATION_REVIEW', 'IN_PROGRESS', 'WARRANTY'];

const actionForStatus = (status, role) => {
  const customer = {
    POSTED: 'Review incoming bids', BIDDING: 'Review incoming bids', PENDING_DEPOSIT: 'Complete the deposit',
    EN_ROUTE: 'Track handyman arrival', ARRIVED: 'Confirm job progress', QUOTE_PENDING: 'Review the final quote',
    PAYMENT_PENDING: 'Complete payment', IN_PROGRESS: 'Review completion requests', WARRANTY: 'Review warranty progress'
  };
  const handyman = {
    ACCEPTED: 'Start travelling to the job', EN_ROUTE: 'Request arrival confirmation', ARRIVED: 'Prepare the final quote',
    QUOTE_PENDING: 'Complete quote requirements', PAYMENT_PENDING: 'Wait for customer payment', IN_PROGRESS: 'Upload evidence and request completion',
    WARRANTY: 'Review warranty work'
  };
  return (role === 'CUSTOMER' ? customer : handyman)[status] || null;
};

const serializeOverviewJob = (job, reviewState, role) => ({
  job_id: job.id,
  service: job.Service ? { service_id: job.Service.id, name: job.Service.name } : null,
  status: job.current_status,
  scheduled_at: job.scheduled_at,
  updated_at: job.updatedAt,
  acceptance_cycle: Number(job.acceptance_cycle || 0),
  action_label: reviewState?.status === 'PENDING' ? (role === 'CUSTOMER' ? 'Rate your handyman' : 'Rate this customer') : actionForStatus(job.current_status, role),
  destination: role === 'CUSTOMER' ? `/customer/my-jobs/${job.id}` : `/handyman/jobs/${job.id}`,
  review_state: reviewState?.status || 'NOT_AVAILABLE'
});

const getRoleJobs = async (user, { recentLimit = 5 } = {}) => {
  if (user.role === 'CUSTOMER') {
    return Job.findAll({ where: { customer_id: user.id }, include: [{ model: Service, attributes: ['id', 'name'], required: false }], order: [['updatedAt', 'DESC'], ['id', 'DESC']], limit: recentLimit });
  }
  return Job.findAll({ where: { selected_handyman_id: user.id }, include: [{ model: Service, attributes: ['id', 'name'], required: false }], order: [['updatedAt', 'DESC'], ['id', 'DESC']], limit: recentLimit });
};

const getOverview = async (user) => {
  const ownerWhere = user.role === 'CUSTOMER' ? { customer_id: user.id } : { selected_handyman_id: user.id };
  const [statusRows, recentJobs, walletData, rating, activeBidCount, availableCount, profile] = await Promise.all([
    Job.findAll({ attributes: ['current_status', [fn('COUNT', col('id')), 'count']], where: ownerWhere, group: ['current_status'], raw: true }),
    getRoleJobs(user, { recentLimit: 10 }),
    getMyWallets(user.id),
    getRatingSummary(user.id, user.role),
    user.role === 'HANDYMAN' ? Bid.count({ where: { handyman_id: user.id, status: 'PENDING' } }) : Promise.resolve(null),
    user.role === 'HANDYMAN' ? Job.count({ where: { current_status: { [Op.in]: ['POSTED', 'BIDDING'] } } }) : Promise.resolve(null),
    user.role === 'HANDYMAN' ? HandymanProfile.findOne({ where: { user_id: user.id }, attributes: ['handyman_level', 'security_bond_status'] }) : Promise.resolve(null)
  ]);
  const counts = Object.fromEntries(statusRows.map((entry) => [entry.current_status, Number(entry.count || 0)]));
  const reviewStates = await getReviewStateMap({ jobs: recentJobs, actor: user });
  const serialized = recentJobs.map((job) => serializeOverviewJob(job, reviewStates.get(job.id), user.role));
  const needsAction = serialized.filter((item) => item.action_label).slice(0, 8);
  const wallet = walletData.wallets?.find((entry) => entry.wallet_type === `${user.role}_MAIN`) || walletData.wallets?.[0] || null;
  return {
    role: user.role,
    wallet: wallet ? { wallet_type: wallet.wallet_type, currency: wallet.currency, available_balance: wallet.available_balance, status: wallet.status } : null,
    job_summary: {
      total: Object.values(counts).reduce((sum, value) => sum + value, 0),
      active: ACTIVE_STATUSES.reduce((sum, status) => sum + (counts[status] || 0), 0),
      closed: counts.CLOSED || 0,
      cancelled: counts.CANCELLED || 0,
      by_status: counts
    },
    recent_jobs: serialized.slice(0, 5),
    needs_action: needsAction,
    ...(user.role === 'HANDYMAN' ? {
      active_bid_count: activeBidCount,
      available_job_count: availableCount,
      rating_summary: rating,
      handyman_level: profile?.handyman_level || null,
      security_bond_status: profile?.security_bond_status || null
    } : {})
  };
};

const getCanonicalProfile = async (userId) => {
  const user = await User.findByPk(userId, { attributes: ['id', 'full_name', 'email', 'phone_number', 'role', 'is_active', 'avatar_url', 'is_email_verified', 'kyc_status', 'createdAt'] });
  if (!user) return null;
  const [addresses, providers, walletData, rating, statusRows, kycDocuments, profile, services, areas] = await Promise.all([
    UserAddress.findAll({ where: { user_id: user.id }, attributes: ['id', 'province_code', 'ward_code', 'detail_address', 'full_address', 'is_default'], include: [{ model: Province, attributes: ['province_code', 'name', 'short_name'], required: false }, { model: Ward, attributes: ['ward_code', 'name'], required: false }] }),
    AuthProvider.findAll({ where: { user_id: user.id }, attributes: ['provider'] }),
    getMyWallets(user.id),
    getRatingSummary(user.id, user.role),
    Job.findAll({ attributes: ['current_status', [fn('COUNT', col('id')), 'count']], where: user.role === 'CUSTOMER' ? { customer_id: user.id } : { selected_handyman_id: user.id }, group: ['current_status'], raw: true }),
    KycRequest.findAll({ where: { user_id: user.id, submission_id: { [Op.ne]: null } }, attributes: ['submission_id', 'submission_sequence', 'status', 'rejection_reason_code', 'rejection_reason_text', 'createdAt'], order: [['submission_sequence', 'DESC']], limit: 10 }),
    user.role === 'HANDYMAN' ? HandymanProfile.findOne({ where: { user_id: user.id }, attributes: ['handyman_level', 'security_bond_status', 'bio', 'preferred_work_times'] }) : Promise.resolve(null),
    user.role === 'HANDYMAN' ? HandymanService.findAll({ where: { handyman_id: user.id }, attributes: ['id'], include: [{ model: Service, attributes: ['id', 'name', 'icon_url', 'service_code', 'is_active'] }] }) : Promise.resolve([]),
    user.role === 'HANDYMAN' ? HandymanServiceArea.findAll({ where: { handyman_id: user.id }, attributes: ['id', 'province_code', 'ward_code'], include: [{ model: Province, attributes: ['province_code', 'name', 'short_name'], required: false }, { model: Ward, attributes: ['ward_code', 'name'], required: false }] }) : Promise.resolve([])
  ]);
  const byStatus = Object.fromEntries(statusRows.map((entry) => [entry.current_status, Number(entry.count || 0)]));
  const latestKyc = kycDocuments[0];
  const kycSubmissionMap = new Map();
  kycDocuments.forEach((entry) => {
    const plain = entry.get({ plain: true });
    const existing = kycSubmissionMap.get(plain.submission_id);
    if (existing) {
      existing.document_count += 1;
      return;
    }
    kycSubmissionMap.set(plain.submission_id, {
      submission_id: plain.submission_id,
      submission_sequence: plain.submission_sequence,
      status: plain.status,
      rejection_reason_code: plain.rejection_reason_code,
      rejection_reason_text: plain.rejection_reason_text,
      submitted_at: plain.createdAt,
      document_count: 1
    });
  });
  const local = providers.some((entry) => entry.provider === 'LOCAL');
  return {
    id: user.id, full_name: user.full_name, email: user.email, phone_number: user.phone_number, role: user.role,
    avatar_url: user.avatar_url, is_email_verified: Boolean(user.is_email_verified), kyc_status: user.kyc_status,
    is_active: Boolean(user.is_active), created_at: user.createdAt,
    profile: profile ? { handyman_level: profile.handyman_level, security_bond_status: profile.security_bond_status, bio: profile.bio, preferred_work_times: profile.preferred_work_times || [] } : null,
    saved_addresses: addresses.map((entry) => entry.get({ plain: true })),
    services: services.map((entry) => ({ association_id: entry.id, ...entry.Service?.get?.({ plain: true }) })),
    service_areas: areas.map((entry) => entry.get({ plain: true })),
    work_times: profile?.preferred_work_times || [],
    wallet_summary: walletData.wallets || [],
    rating_summary: rating,
    job_summary: { total: Object.values(byStatus).reduce((sum, value) => sum + value, 0), active: ACTIVE_STATUSES.reduce((sum, status) => sum + (byStatus[status] || 0), 0), closed: byStatus.CLOSED || 0, cancelled: byStatus.CANCELLED || 0, by_status: byStatus },
    password_capability: local ? 'HAS_LOCAL_PASSWORD' : 'SET_PASSWORD_REQUIRED',
    linked_providers: providers.map((entry) => entry.provider),
    kyc_submissions: [...kycSubmissionMap.values()],
    kyc_rejection: user.kyc_status === 'REJECTED' && latestKyc ? { reason_code: latestKyc.rejection_reason_code, message: KYC_REJECTION_MESSAGES[latestKyc.rejection_reason_code] || 'The KYC submission could not be verified.', reason_text: latestKyc.rejection_reason_text } : null
  };
};

const getPublicProfile = async (userId) => {
  const user = await User.findOne({
    where: { id: userId, role: { [Op.in]: ['CUSTOMER', 'HANDYMAN'] }, is_active: true },
    attributes: ['id', 'full_name', 'avatar_url', 'role', 'kyc_status', 'createdAt']
  });
  if (!user) return null;
  const [rating, closedJobs, profile, services, areas] = await Promise.all([
    getRatingSummary(user.id, user.role),
    Job.count({ where: user.role === 'CUSTOMER' ? { customer_id: user.id, current_status: 'CLOSED' } : { selected_handyman_id: user.id, current_status: 'CLOSED' } }),
    user.role === 'HANDYMAN' ? HandymanProfile.findOne({ where: { user_id: user.id }, attributes: ['handyman_level', 'security_bond_status', 'bio', 'preferred_work_times'] }) : Promise.resolve(null),
    user.role === 'HANDYMAN' ? HandymanService.findAll({ where: { handyman_id: user.id }, include: [{ model: Service, attributes: ['id', 'name', 'icon_url', 'service_code'], where: { is_active: true }, required: true }] }) : Promise.resolve([]),
    user.role === 'HANDYMAN' ? HandymanServiceArea.findAll({ where: { handyman_id: user.id }, attributes: ['province_code', 'ward_code'], include: [{ model: Province, attributes: ['name', 'short_name'], required: false }, { model: Ward, attributes: ['name'], required: false }] }) : Promise.resolve([])
  ]);
  return {
    user_id: user.id,
    display_name: user.full_name,
    avatar_url: user.avatar_url,
    role: user.role,
    member_since: user.createdAt,
    trust: { kyc_status: user.kyc_status, handyman_level: profile?.handyman_level || null, security_bond_status: profile?.security_bond_status || null },
    rating_summary: rating,
    closed_job_count: closedJobs,
    ...(user.role === 'HANDYMAN' ? {
      bio: profile?.bio || null,
      work_times: profile?.preferred_work_times || [],
      services: services.map((entry) => entry.Service?.get?.({ plain: true })).filter(Boolean),
      service_areas: areas.map((entry) => ({ province: entry.Province?.name || entry.Province?.short_name || null, ward: entry.Ward?.name || null }))
    } : {})
  };
};

export { ACTIVE_STATUSES, actionForStatus, getCanonicalProfile, getOverview, getPublicProfile };
