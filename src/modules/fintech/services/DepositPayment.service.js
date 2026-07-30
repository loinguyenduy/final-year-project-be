import db from '../../../core/database/connection.js';
import Job from '../../matchmaking/models/Job.model.js';
import Bid from '../../matchmaking/models/Bid.model.js';
import { transitionJobToAccepted } from '../../matchmaking/services/AcceptedTransition.service.js';
import Transaction from '../models/Transaction.model.js';
import Wallet from '../models/Wallet.model.js';
import {
  JOB_LIFECYCLE_EVENTS,
  emitJobLifecycleEvent
} from '../../matchmaking/sockets/JobLifecycle.gateway.js';

const DEPOSIT_RATE = 0.1;

const calculateDepositAmount = (proposedPrice) => {
  return Math.round(Number(proposedPrice) * DEPOSIT_RATE);
};

const toMoneyNumber = (value) => Number(value || 0);

const buildWalletDepositInfo = (depositAmount, wallet) => {
  const walletBalance = toMoneyNumber(wallet?.balance);
  const missingAmount = Math.max(0, depositAmount - walletBalance);
  const walletIsBlocked = Boolean(wallet?.is_blocked);

  return {
    wallet_balance: walletBalance,
    missing_amount: missingAmount,
    can_pay_from_wallet: !walletIsBlocked && missingAmount === 0,
    wallet_is_blocked: walletIsBlocked
  };
};

const validateJobAndBid = async (customerId, jobId, bidId, options = {}) => {
  const job = await Job.findByPk(jobId, options);

  if (!job) {
    return { error: { EM: "Job not found.", EC: 404, DT: "" } };
  }
  if (job.customer_id !== customerId) {
    return { error: { EM: "You do not have permission to pay a deposit for this job.", EC: 403, DT: "" } };
  }
  if (job.current_status !== 'BIDDING') {
    return {
      error: {
        EM: "Job must be in BIDDING status before starting a deposit payment.",
        EC: 409,
        DT: { current_status: job.current_status }
      }
    };
  }

  const bid = await Bid.findOne({
    where: {
      id: bidId,
      job_id: jobId,
      status: 'PENDING'
    },
    ...options
  });

  if (!bid) {
    return { error: { EM: "Bid not found or is no longer available.", EC: 404, DT: "" } };
  }

  return { job, bid };
};

const getDepositSummaryService = async (customerId, jobId, bidId) => {
  try {
    const validation = await validateJobAndBid(customerId, jobId, bidId);
    if (validation.error) return validation.error;

    const customerWallet = await Wallet.findOne({
      where: {
        user_id: customerId,
        wallet_type: 'CUSTOMER_MAIN'
      }
    });

    if (!customerWallet) {
      return { EM: "Customer main wallet not found.", EC: 404, DT: "" };
    }

    const depositAmount = calculateDepositAmount(validation.bid.proposed_price);
    const walletInfo = buildWalletDepositInfo(depositAmount, customerWallet);

    return {
      EM: "Deposit summary retrieved successfully.",
      EC: 0,
      DT: {
        job_id: validation.job.id,
        bid_id: validation.bid.id,
        handyman_id: validation.bid.handyman_id,
        proposed_price: toMoneyNumber(validation.bid.proposed_price),
        deposit_rate_percent: 10,
        deposit_amount: depositAmount,
        currency: customerWallet.currency || 'VND',
        ...walletInfo
      }
    };
  } catch (error) {
    console.error(">>> Error in getDepositSummaryService:", error);
    return { EM: "Unable to retrieve deposit summary.", EC: 500, DT: "" };
  }
};

const acceptBidWithWalletDepositService = async (customerId, jobId, bidId) => {
  const trans = await db.transaction();

  try {
    const validation = await validateJobAndBid(customerId, jobId, bidId, {
      transaction: trans,
      lock: trans.LOCK.UPDATE
    });

    if (validation.error) {
      await trans.rollback();
      return validation.error;
    }

    const { job, bid } = validation;

    const customerWallet = await Wallet.findOne({
      where: {
        user_id: customerId,
        wallet_type: 'CUSTOMER_MAIN'
      },
      transaction: trans,
      lock: trans.LOCK.UPDATE
    });

    if (!customerWallet) {
      await trans.rollback();
      return { EM: "Customer main wallet not found.", EC: 404, DT: "" };
    }

    const depositAmount = calculateDepositAmount(bid.proposed_price);
    const walletInfo = buildWalletDepositInfo(depositAmount, customerWallet);

    if (customerWallet.is_blocked) {
      await trans.rollback();
      return {
        EM: "Your wallet is currently blocked.",
        EC: 403,
        DT: {
          deposit_amount: depositAmount,
          ...walletInfo
        }
      };
    }

    if (!walletInfo.can_pay_from_wallet) {
      await trans.rollback();
      return {
        EM: "Insufficient wallet balance to pay the 10% deposit.",
        EC: 402,
        DT: {
          deposit_amount: depositAmount,
          ...walletInfo
        }
      };
    }

    const systemEscrowWallet = await Wallet.findOne({
      where: {
        wallet_type: 'SYSTEM_ESCROW',
        user_id: null
      },
      transaction: trans,
      lock: trans.LOCK.UPDATE
    });

    if (!systemEscrowWallet) {
      await trans.rollback();
      return { EM: "SYSTEM_ESCROW wallet is not initialized.", EC: 500, DT: "" };
    }
    if (systemEscrowWallet.is_blocked) {
      await trans.rollback();
      return { EM: "SYSTEM_ESCROW wallet is currently blocked.", EC: 500, DT: "" };
    }

    const newCustomerBalance = toMoneyNumber(customerWallet.balance) - depositAmount;
    const newEscrowBalance = toMoneyNumber(systemEscrowWallet.balance) + depositAmount;

    await customerWallet.update({ balance: newCustomerBalance }, { transaction: trans });
    await systemEscrowWallet.update({ balance: newEscrowBalance }, { transaction: trans });

    const depositTransaction = await Transaction.create({
      amount: depositAmount,
      transaction_type: 'DEPOSIT_10',
      status: 'SUCCESS',
      payment_method: 'INTERNAL',
      payment_gateway_code: null,
      description: `10% wallet deposit for job ${jobId} and bid ${bidId}`,
      from_wallet_id: customerWallet.id,
      to_wallet_id: systemEscrowWallet.id,
      job_id: jobId,
      expires_at: null
    }, { transaction: trans });

    const bidderRows = await Bid.findAll({
      where: { job_id: job.id },
      attributes: ['handyman_id'],
      transaction: trans
    });

    const acceptedTransition = await transitionJobToAccepted({
      job,
      selectedBid: bid,
      depositTransaction,
      depositAmount,
      changedByUserId: customerId,
      sourceStatus: 'BIDDING',
      transaction: trans
    });

    await trans.commit();
    
    if (acceptedTransition.transitioned) {
      emitJobLifecycleEvent({
        event: JOB_LIFECYCLE_EVENTS.ACCEPTED,
        userIds: [job.customer_id, ...bidderRows.map((row) => row.handyman_id)],
        payload: {
          job_id: job.id,
          current_status: 'ACCEPTED',
          acceptance_cycle: acceptedTransition.acceptanceCycle,
          selected_handyman_id: bid.handyman_id,
          occurred_at: acceptedTransition.acceptedAt
        }
      });
    }

    return {
      EM: "Bid accepted and 10% deposit paid from wallet successfully.",
      EC: 0,
      DT: {
        job_id: job.id,
        job_status: 'ACCEPTED',
        bid_id: bid.id,
        selected_handyman_id: bid.handyman_id,
        final_agreed_price: toMoneyNumber(bid.proposed_price),
        deposit_amount: depositAmount,
        deposit_status: 'HELD',
        deposit_paid_at: acceptedTransition.acceptedAt,
        deposit_transaction_id: depositTransaction.id,
        transaction_status: 'SUCCESS',
        payment_method: 'INTERNAL',
        customer_wallet_balance: newCustomerBalance,
        system_escrow_balance: newEscrowBalance,
        accepted_at: acceptedTransition.acceptedAt,
        contact_unlocked_at: acceptedTransition.acceptedAt,
        acceptance_cycle: acceptedTransition.acceptanceCycle
      }
    };
  } catch (error) {
    if (!trans.finished) {
      await trans.rollback();
    }
    console.error(">>> Error in acceptBidWithWalletDepositService:", error);
    return { EM: "Unable to accept bid with wallet deposit.", EC: 500, DT: "" };
  }
};

export {
  getDepositSummaryService,
  acceptBidWithWalletDepositService,
  calculateDepositAmount
};
