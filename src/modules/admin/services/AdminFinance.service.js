import { Op, fn, col } from 'sequelize';
import User from '../../identity/models/User.model.js';
import Wallet from '../../fintech/models/Wallet.model.js';
import Transaction from '../../fintech/models/Transaction.model.js';
import Job from '../../matchmaking/models/Job.model.js';
import Service from '../../matchmaking/models/Service.model.js';
import EContract from '../../fintech/models/EContract.model.js';
import JobWarranty from '../../matchmaking/models/JobWarranty.model.js';
import { deriveContractsForTransactions, FRIENDLY_TYPES, getWalletAggregates } from '../../fintech/services/TransactionRead.service.js';
import { logSensitiveAdminRead } from './AdminSecurityReadLog.service.js';
import { AdminManagementError, assertUuid, normalizeSearch, parseDate, parsePositiveInteger } from '../utils/adminManagementValidation.util.js';

const WALLET_TYPES = new Set(Wallet.rawAttributes.wallet_type.values || []);
const TRANSACTION_TYPES = new Set(Transaction.rawAttributes.transaction_type.values || []);
const TRANSACTION_STATUSES = new Set(Transaction.rawAttributes.status.values || []);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decimal = (value) => value == null ? '0.00' : String(value);
const monetaryMinorUnits = (value) => {
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
};
const moneyValue = (value, field) => {
  if (value === undefined || value === null || value === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(String(value))) throw new AdminManagementError(`${field} must be a non-negative monetary value.`);
  return String(value);
};
const party = (wallet) => {
  if (!wallet) return { kind: 'EXTERNAL', label: 'External payment provider' };
  if (wallet.wallet_type.startsWith('SYSTEM_')) return { kind: 'SYSTEM', label: wallet.wallet_type.replaceAll('_', ' ') };
  return {
    kind: 'PARTICIPANT', user_id: wallet.User?.id || wallet.user_id || null,
    full_name: wallet.User?.full_name || 'Participant', email: wallet.User?.email || null,
    role: wallet.User?.role || null, wallet_type: wallet.wallet_type
  };
};

const listAdminWallets = async ({ query = {}, admin, correlationId }) => {
  const page = parsePositiveInteger(query.page, 'page', 1, Number.MAX_SAFE_INTEGER);
  const pageSize = parsePositiveInteger(query.page_size, 'page_size', 20, 100);
  const search = normalizeSearch(query.search);
  const ownerRole = String(query.owner_role || 'ALL').trim().toUpperCase();
  const walletType = String(query.wallet_type || 'ALL').trim().toUpperCase();
  const status = String(query.status || 'ALL').trim().toUpperCase();
  const currency = String(query.currency || 'ALL').trim().toUpperCase();
  const sort = String(query.sort || 'UPDATED_DESC').trim().toUpperCase();
  if (!['ALL', 'CUSTOMER', 'HANDYMAN', 'SYSTEM'].includes(ownerRole)) throw new AdminManagementError('owner_role is invalid.');
  if (walletType !== 'ALL' && !WALLET_TYPES.has(walletType)) throw new AdminManagementError('wallet_type is invalid.');
  if (!['ALL', 'ACTIVE', 'BLOCKED'].includes(status)) throw new AdminManagementError('status is invalid.');
  if (currency !== 'ALL' && !/^[A-Z]{3}$/.test(currency)) throw new AdminManagementError('currency must be a three-letter code.');
  const sorts = {
    UPDATED_DESC: [['updatedAt', 'DESC'], ['id', 'DESC']], UPDATED_ASC: [['updatedAt', 'ASC'], ['id', 'ASC']],
    BALANCE_DESC: [['balance', 'DESC'], ['id', 'DESC']], BALANCE_ASC: [['balance', 'ASC'], ['id', 'ASC']],
    TYPE_ASC: [['wallet_type', 'ASC'], ['id', 'ASC']]
  };
  if (!sorts[sort]) throw new AdminManagementError('sort is invalid.');
  const minBalance = moneyValue(query.min_balance, 'min_balance');
  const maxBalance = moneyValue(query.max_balance, 'max_balance');
  if (minBalance !== null && maxBalance !== null && monetaryMinorUnits(minBalance) > monetaryMinorUnits(maxBalance)) throw new AdminManagementError('min_balance must not exceed max_balance.');
  let userIds = null;
  if (search || ['CUSTOMER', 'HANDYMAN'].includes(ownerRole)) {
    const userWhere = { role: ['CUSTOMER', 'HANDYMAN'].includes(ownerRole) ? ownerRole : { [Op.in]: ['CUSTOMER', 'HANDYMAN'] } };
    if (search) userWhere[Op.or] = [
      { full_name: { [Op.iLike]: `%${search}%` } }, { email: { [Op.iLike]: `%${search}%` } }, { phone_number: { [Op.iLike]: `%${search}%` } },
      ...(UUID_PATTERN.test(search) ? [{ id: search }] : [])
    ];
    userIds = (await User.findAll({ where: userWhere, attributes: ['id'], raw: true })).map((entry) => entry.id);
  }
  const systemTypes = ['SYSTEM_ESCROW', 'SYSTEM_PROFIT'];
  const where = {
    ...(walletType !== 'ALL' ? { wallet_type: walletType } : {}),
    ...(status !== 'ALL' ? { is_blocked: status === 'BLOCKED' } : {}),
    ...(currency !== 'ALL' ? { currency } : {}),
    ...(minBalance !== null || maxBalance !== null ? { balance: { ...(minBalance !== null ? { [Op.gte]: minBalance } : {}), ...(maxBalance !== null ? { [Op.lte]: maxBalance } : {}) } } : {})
  };
  if (ownerRole === 'SYSTEM') {
    where.user_id = null;
    where.wallet_type = walletType === 'ALL' ? { [Op.in]: systemTypes } : walletType;
  }
  else if (userIds !== null) where.user_id = { [Op.in]: userIds };
  else if (ownerRole === 'ALL' && search) where.user_id = { [Op.in]: userIds || [] };
  const { rows, count } = await Wallet.findAndCountAll({
    where, attributes: ['id', 'user_id', 'wallet_type', 'balance', 'currency', 'is_blocked', 'createdAt', 'updatedAt'],
    include: [{ model: User, attributes: ['id', 'full_name', 'email', 'phone_number', 'role'], required: false }],
    order: sorts[sort], limit: pageSize, offset: (page - 1) * pageSize
  });
  const [aggregates, summaryRows] = await Promise.all([
    getWalletAggregates(rows.map((entry) => entry.id)),
    Wallet.findAll({
      where,
      attributes: ['currency', 'wallet_type', [fn('COUNT', col('id')), 'wallet_count'], [fn('SUM', col('balance')), 'available_balance']],
      group: ['currency', 'wallet_type'],
      order: [['currency', 'ASC'], ['wallet_type', 'ASC']],
      raw: true
    })
  ]);
  logSensitiveAdminRead({ adminId: admin.id, resourceType: 'WALLET_LIST', correlationId });
  return {
    items: rows.map((entry) => ({
      owner: entry.wallet_type.startsWith('SYSTEM_') ? { kind: 'SYSTEM', label: 'Platform' } : { kind: 'PARTICIPANT', user_id: entry.User?.id, full_name: entry.User?.full_name, email: entry.User?.email, phone_number: entry.User?.phone_number, role: entry.User?.role },
      wallet_type: entry.wallet_type, currency: entry.currency, available_balance: decimal(entry.balance),
      status: entry.is_blocked ? 'BLOCKED' : 'ACTIVE', created_at: entry.createdAt, updated_at: entry.updatedAt,
      ...aggregates.get(entry.id)
    })),
    scope_summary: summaryRows.map((entry) => ({
      currency: entry.currency,
      wallet_type: entry.wallet_type,
      wallet_count: Number(entry.wallet_count || 0),
      available_balance: decimal(entry.available_balance)
    })),
    pagination: { page, page_size: pageSize, total_items: count, total_pages: Math.ceil(count / pageSize) }
  };
};

const resolveWalletFilters = async ({ userId, ownerRole, walletType, search }) => {
  let users = [];
  if (userId) users = await User.findAll({ where: { id: userId, role: { [Op.in]: ['CUSTOMER', 'HANDYMAN'] } }, attributes: ['id'], raw: true });
  else if (ownerRole !== 'ALL' || search) {
    const where = { role: ownerRole === 'ALL' ? { [Op.in]: ['CUSTOMER', 'HANDYMAN'] } : ownerRole };
    if (search) where[Op.or] = [{ full_name: { [Op.iLike]: `%${search}%` } }, { email: { [Op.iLike]: `%${search}%` } }, { phone_number: { [Op.iLike]: `%${search}%` } }];
    users = await User.findAll({ where, attributes: ['id'], raw: true });
  }
  const walletWhere = {
    ...(users.length || userId || ownerRole !== 'ALL' || search ? { user_id: { [Op.in]: users.map((entry) => entry.id) } } : {}),
    ...(walletType !== 'ALL' ? { wallet_type: walletType } : {})
  };
  if (!Object.keys(walletWhere).length) return null;
  return (await Wallet.findAll({ where: walletWhere, attributes: ['id'], raw: true })).map((entry) => entry.id);
};

const normalizeTransactionFilters = async (query) => {
  const page = parsePositiveInteger(query.page, 'page', 1, Number.MAX_SAFE_INTEGER);
  const pageSize = parsePositiveInteger(query.page_size, 'page_size', 20, 100);
  const search = normalizeSearch(query.search);
  const type = String(query.type || 'ALL').trim().toUpperCase();
  const status = String(query.status || 'ALL').trim().toUpperCase();
  const ownerRole = String(query.owner_role || 'ALL').trim().toUpperCase();
  const walletType = String(query.wallet_type || 'ALL').trim().toUpperCase();
  const direction = String(query.direction || 'ALL').trim().toUpperCase();
  const sort = String(query.sort || 'CREATED_DESC').trim().toUpperCase();
  if (type !== 'ALL' && !TRANSACTION_TYPES.has(type)) throw new AdminManagementError('type is invalid.');
  if (status !== 'ALL' && !TRANSACTION_STATUSES.has(status)) throw new AdminManagementError('status is invalid.');
  if (!['ALL', 'CUSTOMER', 'HANDYMAN'].includes(ownerRole)) throw new AdminManagementError('owner_role is invalid.');
  if (walletType !== 'ALL' && !WALLET_TYPES.has(walletType)) throw new AdminManagementError('wallet_type is invalid.');
  if (!['ALL', 'INCOMING', 'OUTGOING', 'INTERNAL'].includes(direction)) throw new AdminManagementError('direction is invalid.');
  if (direction !== 'ALL' && !query.user_id) throw new AdminManagementError('direction requires user_id.');
  if (!['CREATED_DESC', 'CREATED_ASC', 'AMOUNT_DESC', 'AMOUNT_ASC'].includes(sort)) throw new AdminManagementError('sort is invalid.');
  const userId = query.user_id ? assertUuid(query.user_id, 'user_id') : null;
  const jobId = query.job_id ? assertUuid(query.job_id, 'job_id') : null;
  const transactionId = query.transaction_id ? assertUuid(query.transaction_id, 'transaction_id') : null;
  const contractId = query.contract_id ? assertUuid(query.contract_id, 'contract_id') : null;
  const dateFrom = parseDate(query.date_from, 'date_from');
  const dateTo = parseDate(query.date_to, 'date_to', true);
  const minAmount = moneyValue(query.min_amount, 'min_amount');
  const maxAmount = moneyValue(query.max_amount, 'max_amount');
  if (dateFrom && dateTo && dateFrom > dateTo) throw new AdminManagementError('date_from must precede date_to.');
  if (minAmount !== null && maxAmount !== null && monetaryMinorUnits(minAmount) > monetaryMinorUnits(maxAmount)) throw new AdminManagementError('min_amount must not exceed max_amount.');
  return { page, pageSize, search, type, status, ownerRole, walletType, direction, sort, userId, jobId, transactionId, contractId, dateFrom, dateTo, minAmount, maxAmount, acceptanceCycle: query.acceptance_cycle ? parsePositiveInteger(query.acceptance_cycle, 'acceptance_cycle', null, 1000000) : null };
};

const buildAdminTransactionQuery = async (filters) => {
  const where = {
    ...(filters.transactionId ? { id: filters.transactionId } : {}),
    ...(filters.type !== 'ALL' ? { transaction_type: filters.type } : {}),
    ...(filters.status !== 'ALL' ? { status: filters.status } : {}),
    ...(filters.jobId ? { job_id: filters.jobId } : {}),
    ...(filters.acceptanceCycle ? { acceptance_cycle: filters.acceptanceCycle } : {}),
    ...(filters.dateFrom || filters.dateTo ? { createdAt: { ...(filters.dateFrom ? { [Op.gte]: filters.dateFrom } : {}), ...(filters.dateTo ? { [Op.lte]: filters.dateTo } : {}) } } : {}),
    ...(filters.minAmount !== null || filters.maxAmount !== null ? { amount: { ...(filters.minAmount !== null ? { [Op.gte]: filters.minAmount } : {}), ...(filters.maxAmount !== null ? { [Op.lte]: filters.maxAmount } : {}) } } : {})
  };
  let contract = null;
  if (filters.contractId) {
    contract = await EContract.findByPk(filters.contractId, { attributes: ['id', 'job_id', 'acceptance_cycle', 'quote_id'] });
    if (!contract) throw new AdminManagementError('Contract was not found.', 404, 'CONTRACT_NOT_FOUND');
    const warranties = await JobWarranty.findAll({ where: { contract_id: contract.id }, attributes: ['id'], raw: true });
    const contractReferences = [
      ...(contract.quote_id ? [{ quote_id: contract.quote_id }] : []),
      ...(warranties.length ? [{ warranty_id: { [Op.in]: warranties.map((entry) => entry.id) } }] : [])
    ];
    where.job_id = contract.job_id;
    where.acceptance_cycle = contract.acceptance_cycle;
    where[Op.and] = [{ [Op.or]: contractReferences.length ? contractReferences : [{ id: null }] }];
  }
  const walletIds = await resolveWalletFilters(filters);
  const explicitWalletScope = Boolean(filters.userId || filters.ownerRole !== 'ALL' || filters.walletType !== 'ALL');
  let ownershipClauses = null;
  if (filters.direction === 'INCOMING') where[Op.and] = [...(where[Op.and] || []), { to_wallet_id: { [Op.in]: walletIds || [] } }, { [Op.or]: [{ from_wallet_id: { [Op.notIn]: walletIds || [] } }, { from_wallet_id: null }] }];
  else if (filters.direction === 'OUTGOING') where[Op.and] = [...(where[Op.and] || []), { from_wallet_id: { [Op.in]: walletIds || [] } }, { [Op.or]: [{ to_wallet_id: { [Op.notIn]: walletIds || [] } }, { to_wallet_id: null }] }];
  else if (filters.direction === 'INTERNAL') Object.assign(where, { from_wallet_id: { [Op.in]: walletIds || [] }, to_wallet_id: { [Op.in]: walletIds || [] } });
  else if (walletIds) {
    ownershipClauses = [{ from_wallet_id: { [Op.in]: walletIds } }, { to_wallet_id: { [Op.in]: walletIds } }, ...(filters.userId ? [{ payer_user_id: filters.userId }] : [])];
    if (explicitWalletScope) where[Op.or] = ownershipClauses;
  }
  if (filters.search) {
    const searchClauses = [
      { payment_gateway_code: { [Op.iLike]: `%${filters.search}%` } },
      { description: { [Op.iLike]: `%${filters.search}%` } }
    ];
    if (UUID_PATTERN.test(filters.search)) searchClauses.push({ id: filters.search }, { job_id: filters.search });
    if (!explicitWalletScope && ownershipClauses) searchClauses.push(...ownershipClauses);
    if (where[Op.or]) {
      const scope = where[Op.or];
      delete where[Op.or];
      where[Op.and] = [...(where[Op.and] || []), { [Op.or]: scope }, { [Op.or]: searchClauses }];
    } else where[Op.or] = searchClauses;
  }
  return where;
};

const transactionIncludes = [
  { model: Wallet, as: 'FromWallet', attributes: ['id', 'user_id', 'wallet_type', 'currency'], include: [{ model: User, attributes: ['id', 'full_name', 'email', 'role'], required: false }] },
  { model: Wallet, as: 'ToWallet', attributes: ['id', 'user_id', 'wallet_type', 'currency'], include: [{ model: User, attributes: ['id', 'full_name', 'email', 'role'], required: false }] },
  { model: Job, attributes: ['id', 'current_status', 'issue_description'], include: [{ model: Service, attributes: ['name'], required: false }], required: false }
];

const mapAdminTransaction = (entry, contracts) => {
  const contract = contracts.byWarranty.get(entry.warranty_id) || contracts.byQuote.get(entry.quote_id) || null;
  return {
    transaction_id: entry.id, type: entry.transaction_type,
    friendly_type: FRIENDLY_TYPES[entry.transaction_type] || entry.transaction_type,
    status: entry.status, amount: decimal(entry.amount),
    currency: entry.FromWallet?.currency || entry.ToWallet?.currency || 'VND',
    source: party(entry.FromWallet), destination: party(entry.ToWallet),
    job: entry.Job ? { job_id: entry.Job.id, status: entry.Job.current_status, display_title: [entry.Job.Service?.name, String(entry.Job.issue_description || '').slice(0, 60)].filter(Boolean).join(' — ') } : null,
    acceptance_cycle: entry.acceptance_cycle,
    contract: contract ? { contract_id: contract.id, contract_number: contract.contract_number || null } : null,
    provider_reference: entry.payment_gateway_code || null, payment_method: entry.payment_method || null,
    description: entry.description || null, reference_transaction_id: entry.reference_transaction_id || null,
    created_at: entry.createdAt, last_updated_at: entry.updatedAt
  };
};

const listAdminTransactions = async ({ query = {}, admin, correlationId }) => {
  const filters = await normalizeTransactionFilters(query);
  const where = await buildAdminTransactionQuery(filters);
  const order = filters.sort === 'CREATED_ASC' ? [['createdAt', 'ASC'], ['id', 'ASC']]
    : filters.sort === 'AMOUNT_DESC' ? [['amount', 'DESC'], ['id', 'DESC']]
      : filters.sort === 'AMOUNT_ASC' ? [['amount', 'ASC'], ['id', 'ASC']]
        : [['createdAt', 'DESC'], ['id', 'DESC']];
  const { rows, count } = await Transaction.findAndCountAll({ where, include: transactionIncludes, order, limit: filters.pageSize, offset: (filters.page - 1) * filters.pageSize, distinct: true });
  const contracts = await deriveContractsForTransactions(rows);
  logSensitiveAdminRead({ adminId: admin.id, resourceType: 'TRANSACTION_LIST', correlationId });
  return { items: rows.map((entry) => mapAdminTransaction(entry, contracts)), pagination: { page: filters.page, page_size: filters.pageSize, total_items: count, total_pages: Math.ceil(count / filters.pageSize) } };
};

const getAdminTransactionDetail = async ({ transactionId, admin, correlationId }) => {
  assertUuid(transactionId, 'transactionId');
  const entry = await Transaction.findByPk(transactionId, { include: transactionIncludes });
  if (!entry) throw new AdminManagementError('Transaction was not found.', 404, 'ADMIN_TRANSACTION_NOT_FOUND');
  const contracts = await deriveContractsForTransactions([entry]);
  logSensitiveAdminRead({ adminId: admin.id, transactionId: entry.id, jobId: entry.job_id, resourceType: 'TRANSACTION_DETAIL', correlationId });
  return {
    ...mapAdminTransaction(entry, contracts),
    business_references: {
      quote_id: entry.quote_id || null, cancellation_id: entry.cancellation_id || null,
      completion_request_id: entry.completion_request_id || null, warranty_id: entry.warranty_id || null,
      warranty_completion_request_id: entry.warranty_completion_request_id || null
    }
  };
};

export { getAdminTransactionDetail, listAdminTransactions, listAdminWallets };
