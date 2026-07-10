import { Op } from 'sequelize';
import db from '../../../core/database/connection.js';
import Transaction from '../models/Transaction.model.js';
import Wallet from '../models/Wallet.model.js';
import Job from '../../matchmaking/models/Job.model.js';
import Bid from '../../matchmaking/models/Bid.model.js';
import JobStatusHistory from '../../matchmaking/models/JobStatusHistory.model.js';
import HandymanProfile from '../../identity/models/HandymanProfile.model.js';

const restoreJobToBidding = async (paymentTransaction, {
  transaction,
  changedByUserId = null
}) => {
  if (paymentTransaction.transaction_type !== 'DEPOSIT_10' || !paymentTransaction.job_id) {
    return;
  }

  const job = await Job.findByPk(paymentTransaction.job_id, {
    transaction,
    lock: transaction.LOCK.UPDATE
  });

  if (!job) {
    return;
  }

  const isThisDepositLockedOnJob = job.deposit_transaction_id === paymentTransaction.id;
  if (!isThisDepositLockedOnJob) {
    return;
  }

  if (job.current_status === 'PENDING_DEPOSIT') {
    await job.update({
      current_status: 'BIDDING',
      selected_bid_id: null,
      deposit_transaction_id: null,
      deposit_amount: null
    }, { transaction });

    await JobStatusHistory.create({
      job_id: job.id,
      changed_by_user_id: changedByUserId,
      old_status: 'PENDING_DEPOSIT',
      new_status: 'BIDDING'
    }, { transaction });

    return;
  }

  if (job.current_status !== 'BIDDING') {
    return;
  }

  // Some older failed/expired flows already restored the status to BIDDING but
  // left these lock fields behind. Clean them so the customer can create a new
  // deposit payment for the same job.
  await job.update({
    selected_bid_id: null,
    deposit_transaction_id: null,
    deposit_amount: null
  }, { transaction });
};

const markPendingTransactionService = async ({
  transactionId = null,
  paymentMethod = null,
  gatewayCode = null,
  newStatus,
  changedByUserId = null
}) => {
  const trans = await db.transaction();

  try {
    const where = transactionId
      ? { id: transactionId }
      : {
          payment_method: paymentMethod,
          payment_gateway_code: String(gatewayCode)
        };

    const paymentTransaction = await Transaction.findOne({
      where,
      transaction: trans,
      lock: trans.LOCK.UPDATE
    });

    if (!paymentTransaction) {
      await trans.rollback();
      return { EM: "Transaction not found.", EC: 404, DT: "" };
    }

    if (paymentTransaction.status !== 'PENDING') {
      if (
        ['FAILED', 'EXPIRED'].includes(paymentTransaction.status)
        && ['FAILED', 'EXPIRED'].includes(newStatus)
      ) {
        await restoreJobToBidding(paymentTransaction, {
          transaction: trans,
          changedByUserId
        });
      }

      await trans.commit();
      return {
        EM: "Transaction was already processed.",
        EC: 0,
        DT: {
          transaction_id: paymentTransaction.id,
          status: paymentTransaction.status,
          already_processed: true
        }
      };
    }

    await paymentTransaction.update({ status: newStatus }, { transaction: trans });
    await restoreJobToBidding(paymentTransaction, {
      transaction: trans,
      changedByUserId
    });

    await trans.commit();
    return {
      EM: `Transaction marked as ${newStatus}.`,
      EC: 0,
      DT: {
        transaction_id: paymentTransaction.id,
        status: newStatus,
        already_processed: false
      }
    };
  } catch (error) {
    await trans.rollback();
    console.error(">>> Error in markPendingTransactionService:", error);
    return { EM: "Unable to update transaction status.", EC: 500, DT: "" };
  }
};

const processSuccessfulGatewayPayment = async ({
  paymentMethod,
  gatewayCode,
  paidAmount
}) => {
  const trans = await db.transaction();

  try {
    const paymentTransaction = await Transaction.findOne({
      where: {
        payment_method: paymentMethod,
        payment_gateway_code: String(gatewayCode)
      },
      transaction: trans,
      lock: trans.LOCK.UPDATE
    });

    if (!paymentTransaction) {
      await trans.rollback();
      return { EM: "Transaction not found.", EC: 404, DT: "" };
    }

    if (paymentTransaction.status === 'SUCCESS') {
      await trans.commit();
      return {
        EM: "Transaction was already completed.",
        EC: 0,
        DT: {
          transaction_id: paymentTransaction.id,
          status: 'SUCCESS',
          already_processed: true
        }
      };
    }

    if (paymentTransaction.status !== 'PENDING') {
      await trans.rollback();
      return {
        EM: `Transaction is already ${paymentTransaction.status}.`,
        EC: 409,
        DT: { status: paymentTransaction.status }
      };
    }

    if (Number(paymentTransaction.amount) !== Number(paidAmount)) {
      await trans.rollback();
      return { EM: "Payment amount does not match the transaction.", EC: 400, DT: "" };
    }

    const destinationWallet = await Wallet.findByPk(paymentTransaction.to_wallet_id, {
      transaction: trans,
      lock: trans.LOCK.UPDATE
    });

    if (!destinationWallet) {
      await trans.rollback();
      return { EM: "Destination wallet not found.", EC: 404, DT: "" };
    }

    if (paymentTransaction.transaction_type === 'DEPOSIT_10') {
      if (
        destinationWallet.wallet_type !== 'SYSTEM_ESCROW'
        || destinationWallet.user_id !== null
      ) {
        await trans.rollback();
        return {
          EM: "Deposit destination must be the shared SYSTEM_ESCROW wallet.",
          EC: 409,
          DT: ""
        };
      }

      const job = await Job.findByPk(paymentTransaction.job_id, {
        transaction: trans,
        lock: trans.LOCK.UPDATE
      });

      if (
        !job
        || job.current_status !== 'PENDING_DEPOSIT'
        || job.deposit_transaction_id !== paymentTransaction.id
        || !job.selected_bid_id
      ) {
        await trans.rollback();
        return {
          EM: "Job is no longer waiting for this deposit transaction.",
          EC: 409,
          DT: ""
        };
      }

      const selectedBid = await Bid.findOne({
        where: {
          id: job.selected_bid_id,
          job_id: job.id,
          status: 'PENDING'
        },
        transaction: trans,
        lock: trans.LOCK.UPDATE
      });

      if (!selectedBid) {
        await trans.rollback();
        return { EM: "Selected bid is no longer available.", EC: 409, DT: "" };
      }

      await destinationWallet.increment(
        { balance: Number(paymentTransaction.amount) },
        { transaction: trans }
      );
      await paymentTransaction.update({ status: 'SUCCESS' }, { transaction: trans });
      await selectedBid.update({ status: 'WON' }, { transaction: trans });
      await Bid.update(
        { status: 'LOST' },
        {
          where: {
            job_id: job.id,
            id: { [Op.ne]: selectedBid.id },
            status: 'PENDING'
          },
          transaction: trans
        }
      );

      const acceptedAt = new Date();
      await job.update({
        selected_handyman_id: selectedBid.handyman_id,
        final_agreed_price: selectedBid.proposed_price,
        deposit_amount: paymentTransaction.amount,
        current_status: 'ACCEPTED',
        accepted_at: acceptedAt,
        contact_unlocked_at: acceptedAt
      }, { transaction: trans });

      await JobStatusHistory.create({
        job_id: job.id,
        changed_by_user_id: job.customer_id,
        old_status: 'PENDING_DEPOSIT',
        new_status: 'ACCEPTED'
      }, { transaction: trans });
    } else {
      await destinationWallet.increment(
        { balance: Number(paymentTransaction.amount) },
        { transaction: trans }
      );
      await paymentTransaction.update({ status: 'SUCCESS' }, { transaction: trans });

      if (paymentTransaction.transaction_type === 'BONDING_DEPOSIT') {
        await HandymanProfile.update(
          { security_bond_status: 'PAID', handyman_level: 'C3' },
          {
            where: { user_id: destinationWallet.user_id },
            transaction: trans
          }
        );
      }
    }

    await trans.commit();
    return {
      EM: "Payment completed successfully.",
      EC: 0,
      DT: {
        transaction_id: paymentTransaction.id,
        status: 'SUCCESS',
        already_processed: false
      }
    };
  } catch (error) {
    await trans.rollback();
    console.error(">>> Error in processSuccessfulGatewayPayment:", error);
    return { EM: "Unable to settle payment.", EC: 500, DT: "" };
  }
};

const processFailedGatewayPayment = async ({
  paymentMethod,
  gatewayCode,
  changedByUserId = null
}) => {
  return markPendingTransactionService({
    paymentMethod,
    gatewayCode,
    newStatus: 'FAILED',
    changedByUserId
  });
};

const processExpiredGatewayPayment = async ({
  paymentMethod,
  gatewayCode,
  changedByUserId = null
}) => {
  return markPendingTransactionService({
    paymentMethod,
    gatewayCode,
    newStatus: 'EXPIRED',
    changedByUserId
  });
};

const expireTransactionByIdService = async (transactionId) => {
  return markPendingTransactionService({
    transactionId,
    newStatus: 'EXPIRED'
  });
};

const cancelTransactionByIdService = async (transactionId, customerId) => {
  return markPendingTransactionService({
    transactionId,
    newStatus: 'FAILED',
    changedByUserId: customerId
  });
};

export {
  processSuccessfulGatewayPayment,
  processFailedGatewayPayment,
  processExpiredGatewayPayment,
  expireTransactionByIdService,
  cancelTransactionByIdService
};
