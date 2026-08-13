import { Op, fn, col, literal } from 'sequelize';
import Wallet from '../models/Wallet.model.js';
import Transaction from '../models/Transaction.model.js';
import Job from '../../matchmaking/models/Job.model.js';
import Service from '../../matchmaking/models/Service.model.js';
import User from '../../identity/models/User.model.js';
import EContract from '../models/EContract.model.js';
import JobWarranty from '../../matchmaking/models/JobWarranty.model.js';
import { AdminManagementError, parseDate, parsePositiveInteger } from '../../admin/utils/adminManagementValidation.util.js';

const FRIENDLY_TYPES = Object.freeze({
  TOP_UP: 'Wallet top-up', WITHDRAW: 'Withdrawal', DEPOSIT_10: 'Job deposit',
  LOCK_100: 'Escrow lock', PLATFORM_FEE_10: 'Platform fee', WARRANTY_HOLD_20: 'Warranty hold',
  DISBURSE_80: 'Service disbursement', PLATFORM_SERVICE_FEE: 'Platform service fee',
  WARRANTY_RESERVE_HOLD: 'Warranty reserve hold', HANDYMAN_PARTIAL_RELEASE: 'Service earnings',
  WARRANTY_RELEASE: 'Warranty reserve release', WARRANTY_REFUND: 'Warranty refund', REFUND: 'Refund',
  DEPOSIT_REFUND: 'Deposit refund', BONDING_DEPOSIT: 'Security bond deposit',
  CANCELLATION_REFUND: 'Cancellation refund', CANCELLATION_COMPENSATION: 'Cancellation compensation',
  CANCELLATION_PLATFORM_FEE: 'Cancellation platform fee', SERVICE_REMAINING_PAYMENT: 'Remaining service payment'
});

const decimal = (value) => value == null ? '0.00' : String(value);
const encodeCursor = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const decodeCursor = (cursor) => {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!value.at || !value.id) throw new Error();
    return value;
  } catch { throw new AdminManagementError('cursor is invalid.'); }
};

const walletStatus = (wallet) => wallet.is_blocked ? 'BLOCKED' : 'ACTIVE';

// Hàm để lấy tổng hợp thông tin giao dịch cho một danh sách các ID ví, bao gồm tổng số tiền đến, tổng số tiền đi, số lượng giao dịch thành công, đang chờ xử lý và thất bại, cũng như thời điểm giao dịch cuối cùng.
const getWalletAggregates = async (walletIds) => {
  if (!walletIds.length) return new Map();
  const aggregate = (field) => Transaction.findAll({
    attributes: [field,
      [fn('SUM', literal(`CASE WHEN "status" = 'SUCCESS' THEN "amount" ELSE 0 END`)), 'successful_amount'],
      [fn('COUNT', col('id')), 'count'],
      [fn('SUM', literal(`CASE WHEN "status" = 'SUCCESS' THEN 1 ELSE 0 END`)), 'successful_count'],
      [fn('SUM', literal(`CASE WHEN "status" = 'PENDING' THEN 1 ELSE 0 END`)), 'pending_count'],
      [fn('SUM', literal(`CASE WHEN "status" = 'FAILED' THEN 1 ELSE 0 END`)), 'failed_count'],
      [fn('MAX', col('createdAt')), 'last_transaction_at']],
    where: { [field]: { [Op.in]: walletIds } }, group: [field], raw: true
  });
  const [incoming, outgoing] = await Promise.all([aggregate('to_wallet_id'), aggregate('from_wallet_id')]);
  const result = new Map(walletIds.map((id) => [id, { total_incoming: '0.00', total_outgoing: '0.00', successful_transaction_count: 0, pending_transaction_count: 0, failed_transaction_count: 0, last_transaction_at: null }]));
  incoming.forEach((entry) => Object.assign(result.get(entry.to_wallet_id), {
    total_incoming: decimal(entry.successful_amount), successful_transaction_count: Number(entry.successful_count || 0),
    pending_transaction_count: Number(entry.pending_count || 0), failed_transaction_count: Number(entry.failed_count || 0),
    last_transaction_at: entry.last_transaction_at
  }));
  outgoing.forEach((entry) => {
    const current = result.get(entry.from_wallet_id);
    current.total_outgoing = decimal(entry.successful_amount);
    current.successful_transaction_count += Number(entry.successful_count || 0);
    current.pending_transaction_count += Number(entry.pending_count || 0);
    current.failed_transaction_count += Number(entry.failed_count || 0);
    if (!current.last_transaction_at || new Date(entry.last_transaction_at) > new Date(current.last_transaction_at)) current.last_transaction_at = entry.last_transaction_at;
  });
  return result;
};

// Hàm để lấy tất cả các giao dịch liên quan đến một người dùng cụ thể, với các tùy chọn lọc và phân trang.
const getMyWallets = async (userId) => {
  const wallets = await Wallet.findAll({ where: { user_id: userId }, attributes: ['id', 'wallet_type', 'balance', 'currency', 'is_blocked', 'updatedAt'], order: [['wallet_type', 'ASC']] });
  const aggregates = await getWalletAggregates(wallets.map((entry) => entry.id));
  return {
    wallets: wallets.map((entry) => ({
      wallet_type: entry.wallet_type, currency: entry.currency, available_balance: decimal(entry.balance),
      status: walletStatus(entry), updated_at: entry.updatedAt, ...aggregates.get(entry.id)
    }))
  };
};

const partyLabel = (wallet, ownWalletIds) => {
  if (!wallet) return { kind: 'EXTERNAL', label: 'External payment provider' };
  if (ownWalletIds.has(wallet.id)) return { kind: 'SELF', label: wallet.wallet_type.replaceAll('_', ' ') };
  if (wallet.wallet_type.startsWith('SYSTEM_')) return { kind: 'SYSTEM', label: wallet.wallet_type.replaceAll('_', ' ') };
  return { kind: 'PARTICIPANT', label: 'Service participant' };
};

// 
const getMyTransactions = async ({ userId, query = {} }) => {
  const limit = parsePositiveInteger(query.limit, 'limit', 20, 100);
  const wallets = await Wallet.findAll({ where: { user_id: userId }, attributes: ['id', 'wallet_type', 'currency'] });
  const ownIds = wallets.map((entry) => entry.id);
  if (!ownIds.length) return { items: [], has_more: false, next_cursor: null };
  const cursor = decodeCursor(query.cursor);
  const type = String(query.type || 'ALL').trim().toUpperCase();
  const status = String(query.status || 'ALL').trim().toUpperCase();
  const direction = String(query.direction || 'ALL').trim().toUpperCase();
  const types = Transaction.rawAttributes.transaction_type.values || [];
  const statuses = Transaction.rawAttributes.status.values || [];
  if (type !== 'ALL' && !types.includes(type)) throw new AdminManagementError('type is invalid.');
  if (status !== 'ALL' && !statuses.includes(status)) throw new AdminManagementError('status is invalid.');
  if (!['ALL', 'INCOMING', 'OUTGOING', 'INTERNAL'].includes(direction)) throw new AdminManagementError('direction is invalid.');
  const dateFrom = parseDate(query.date_from, 'date_from');
  const dateTo = parseDate(query.date_to, 'date_to', true);
  const ownership = direction === 'INCOMING'
    ? { [Op.and]: [{ to_wallet_id: { [Op.in]: ownIds } }, { [Op.or]: [{ from_wallet_id: { [Op.notIn]: ownIds } }, { from_wallet_id: null }] }] }
    : direction === 'OUTGOING'
      ? { [Op.and]: [{ from_wallet_id: { [Op.in]: ownIds } }, { [Op.or]: [{ to_wallet_id: { [Op.notIn]: ownIds } }, { to_wallet_id: null }] }] }
      : direction === 'INTERNAL'
        ? { from_wallet_id: { [Op.in]: ownIds }, to_wallet_id: { [Op.in]: ownIds } }
        : { [Op.or]: [{ from_wallet_id: { [Op.in]: ownIds } }, { to_wallet_id: { [Op.in]: ownIds } }] };
  const rows = await Transaction.findAll({
    where: {
      ...ownership,
      ...(type !== 'ALL' ? { transaction_type: type } : {}),
      ...(status !== 'ALL' ? { status } : {}),
      ...(dateFrom || dateTo ? { createdAt: { ...(dateFrom ? { [Op.gte]: dateFrom } : {}), ...(dateTo ? { [Op.lte]: dateTo } : {}) } } : {}),
      ...(cursor ? { [Op.and]: [{ [Op.or]: [{ createdAt: { [Op.lt]: cursor.at } }, { createdAt: cursor.at, id: { [Op.lt]: cursor.id } }] }] } : {})
    },
    include: [
      { model: Wallet, as: 'FromWallet', attributes: ['id', 'wallet_type', 'currency'] },
      { model: Wallet, as: 'ToWallet', attributes: ['id', 'wallet_type', 'currency'] },
      { model: Job, attributes: ['id', 'issue_description'], include: [{ model: Service, attributes: ['name'], required: false }], required: false }
    ],
    order: [['createdAt', 'DESC'], ['id', 'DESC']], limit: limit + 1
  });
  const ownSet = new Set(ownIds);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const items = page.map((entry) => {
    const fromOwn = ownSet.has(entry.from_wallet_id);
    const toOwn = ownSet.has(entry.to_wallet_id);
    const computedDirection = fromOwn && toOwn ? 'INTERNAL' : toOwn ? 'INCOMING' : 'OUTGOING';
    return {
      transaction_id: entry.id, friendly_description: FRIENDLY_TYPES[entry.transaction_type] || entry.transaction_type,
      description: entry.description || null, type: entry.transaction_type, status: entry.status,
      direction: computedDirection, amount: decimal(entry.amount),
      currency: entry.FromWallet?.currency || entry.ToWallet?.currency || 'VND',
      counterparty: computedDirection === 'INCOMING' ? partyLabel(entry.FromWallet, ownSet) : partyLabel(entry.ToWallet, ownSet),
      related_job: entry.Job ? { job_id: entry.Job.id, display_title: [entry.Job.Service?.name, String(entry.Job.issue_description || '').slice(0, 60)].filter(Boolean).join(' — ') } : null,
      created_at: entry.createdAt, last_updated_at: entry.updatedAt
    };
  });
  const last = page.at(-1);
  return { items, has_more: hasMore, next_cursor: hasMore && last ? encodeCursor({ at: last.createdAt, id: last.id }) : null };
};

const deriveContractsForTransactions = async (transactions) => {
  const quoteIds = [...new Set(transactions.map((entry) => entry.quote_id).filter(Boolean))];
  const warrantyIds = [...new Set(transactions.map((entry) => entry.warranty_id).filter(Boolean))];
  const [contracts, warranties] = await Promise.all([
    quoteIds.length ? EContract.findAll({ where: { quote_id: { [Op.in]: quoteIds } }, attributes: ['id', 'quote_id', 'contract_number'], raw: true }) : [],
    warrantyIds.length ? JobWarranty.findAll({ where: { id: { [Op.in]: warrantyIds } }, attributes: ['id', 'contract_id'], raw: true }) : []
  ]);
  const contractIds = [...new Set(warranties.map((entry) => entry.contract_id).filter(Boolean))];
  const warrantyContracts = contractIds.length ? await EContract.findAll({ where: { id: { [Op.in]: contractIds } }, attributes: ['id', 'contract_number'], raw: true }) : [];
  const byQuote = new Map(contracts.map((entry) => [entry.quote_id, entry]));
  const contractById = new Map(warrantyContracts.map((entry) => [entry.id, entry]));
  const byWarranty = new Map(warranties.map((entry) => [entry.id, contractById.get(entry.contract_id) || { id: entry.contract_id, contract_number: null }]));
  return { byQuote, byWarranty };
};

export { FRIENDLY_TYPES, deriveContractsForTransactions, getMyTransactions, getMyWallets, getWalletAggregates };
