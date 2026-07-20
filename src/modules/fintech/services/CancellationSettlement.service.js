import { Op } from 'sequelize';
import Transaction from '../models/Transaction.model.js';
import Wallet from '../models/Wallet.model.js';
import { parseDecimalHundredths, parseVndInteger } from '../../matchmaking/utils/cancellationPolicy.util.js';

const settlementError = (EM, EC, code, DT = '') => ({ error: { EM, EC, code, DT } });

const createPayoutTransaction = async ({
  cancellation,
  job,
  originalDeposit,
  transactionType,
  amount,
  fromWallet,
  toWallet,
  transferKey,
  transaction
}) => {
  if (amount === 0n) return null;
  const idempotencyKey = `cancellation:${cancellation.id}:${transferKey}`;
  const existing = await Transaction.findOne({
    where: { idempotency_key: idempotencyKey },
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  if (existing) return existing;
  return Transaction.create({
    amount: amount.toString(),
    transaction_type: transactionType,
    status: 'SUCCESS',
    payment_method: 'INTERNAL',
    payment_gateway_code: null,
    description: `${transferKey} for cancelled job ${job.id}`,
    from_wallet_id: fromWallet.id,
    to_wallet_id: toWallet.id,
    job_id: job.id,
    reference_transaction_id: originalDeposit.id,
    cancellation_id: cancellation.id,
    idempotency_key: idempotencyKey,
    expires_at: null
  }, { transaction });
};

const settleCancellationFundsInTransaction = async ({
  job,
  cancellation,
  invariant,
  distribution,
  transaction
}) => {
  if (!distribution?.valid
      || distribution.depositAmount !== invariant.depositAmount
      || distribution.customerAmount + distribution.handymanAmount + distribution.platformAmount !== distribution.depositAmount
      || distribution.platformAmount !== 0n) {
    return settlementError('Cancellation financial distribution is inconsistent.', 409, 'FINANCIAL_DATA_INCONSISTENT');
  }

  const wallets = await Wallet.findAll({
    where: {
      [Op.or]: [
        { user_id: job.customer_id, wallet_type: 'CUSTOMER_MAIN' },
        { user_id: job.selected_handyman_id, wallet_type: 'HANDYMAN_MAIN' },
        { user_id: null, wallet_type: 'SYSTEM_ESCROW' }
      ]
    },
    order: [['id', 'ASC']],
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  const customerWallet = wallets.find((wallet) => wallet.user_id === job.customer_id && wallet.wallet_type === 'CUSTOMER_MAIN');
  const handymanWallet = wallets.find((wallet) => wallet.user_id === job.selected_handyman_id && wallet.wallet_type === 'HANDYMAN_MAIN');
  const systemEscrow = wallets.find((wallet) => wallet.user_id === null && wallet.wallet_type === 'SYSTEM_ESCROW');
  if (!customerWallet || !handymanWallet || !systemEscrow) {
    return settlementError('A required cancellation wallet was not found.', 404, 'CANCELLATION_WALLET_NOT_FOUND');
  }
  if (wallets.some((wallet) => wallet.is_blocked) || wallets.some((wallet) => wallet.currency !== 'VND')) {
    return settlementError('A cancellation wallet is blocked or has an invalid currency.', 409, 'CANCELLATION_WALLET_BLOCKED');
  }

  const originalDeposit = await Transaction.findOne({
    where: {
      id: job.deposit_transaction_id,
      job_id: job.id,
      transaction_type: 'DEPOSIT_10',
      status: 'SUCCESS'
    },
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  const originalAmount = parseVndInteger(originalDeposit?.amount);
  if (!originalDeposit || originalDeposit.to_wallet_id !== systemEscrow.id
      || !originalAmount.valid || originalAmount.amount !== invariant.depositAmount) {
    return settlementError('Original deposit transaction is missing or inconsistent.', 409, 'FINANCIAL_DATA_INCONSISTENT');
  }
  const releases = await Transaction.findAll({
    where: {
      reference_transaction_id: originalDeposit.id,
      status: 'SUCCESS',
      transaction_type: { [Op.in]: ['DEPOSIT_REFUND', 'CANCELLATION_REFUND', 'CANCELLATION_COMPENSATION'] }
    },
    order: [['id', 'ASC']],
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  if (releases.length) {
    return settlementError('This deposit has already been released.', 409, 'DEPOSIT_ALREADY_RELEASED');
  }
  const escrowBalance = parseDecimalHundredths(systemEscrow.balance);
  if (!escrowBalance.valid || escrowBalance.amount < distribution.depositAmount * 100n) {
    return settlementError('SYSTEM_ESCROW does not have enough balance for this cancellation.', 409, 'ESCROW_INSUFFICIENT_BALANCE');
  }

  await systemEscrow.decrement('balance', { by: distribution.depositAmount.toString(), transaction });
  if (distribution.customerAmount > 0n) {
    await customerWallet.increment('balance', { by: distribution.customerAmount.toString(), transaction });
  }
  if (distribution.handymanAmount > 0n) {
    await handymanWallet.increment('balance', { by: distribution.handymanAmount.toString(), transaction });
  }
  const customerTransaction = await createPayoutTransaction({
    cancellation,
    job,
    originalDeposit,
    transactionType: 'CANCELLATION_REFUND',
    amount: distribution.customerAmount,
    fromWallet: systemEscrow,
    toWallet: customerWallet,
    transferKey: 'CUSTOMER_REFUND',
    transaction
  });
  const handymanTransaction = await createPayoutTransaction({
    cancellation,
    job,
    originalDeposit,
    transactionType: 'CANCELLATION_COMPENSATION',
    amount: distribution.handymanAmount,
    fromWallet: systemEscrow,
    toWallet: handymanWallet,
    transferKey: 'HANDYMAN_COMPENSATION',
    transaction
  });
  return {
    customerTransaction,
    handymanTransaction,
    depositStatus: distribution.handymanAmount === 0n ? 'REFUNDED' : 'DISTRIBUTED'
  };
};

export { settleCancellationFundsInTransaction };
