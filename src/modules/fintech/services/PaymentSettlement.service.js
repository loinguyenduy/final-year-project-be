import db from '../../../core/database/connection.js';
import Transaction from '../models/Transaction.model.js';
import Wallet from '../models/Wallet.model.js';
import Job from '../../matchmaking/models/Job.model.js';
import Bid from '../../matchmaking/models/Bid.model.js';
import JobStatusHistory from '../../matchmaking/models/JobStatusHistory.model.js';
import { transitionJobToAccepted } from '../../matchmaking/services/AcceptedTransition.service.js';
import HandymanProfile from '../../identity/models/HandymanProfile.model.js';
import {
  JOB_LIFECYCLE_EVENTS,
  emitJobLifecycleEvent
} from '../../matchmaking/sockets/JobLifecycle.gateway.js';

// Hàm để khôi phục trạng thái công việc về "BIDDING" nếu giao dịch thanh toán bị thất bại hoặc hết hạn, và xóa các trường khóa liên quan đến giao dịch đó.
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

// Hàm để đánh dấu một giao dịch đang chờ xử lý (PENDING) thành trạng thái mới (FAILED hoặc EXPIRED), 
// và nếu giao dịch liên quan đến một công việc, khôi phục trạng thái công việc về "BIDDING" nếu cần thiết.
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

// Hàm để xử lý thanh toán thành công từ cổng thanh toán, xác nhận giao dịch
const processSuccessfulGatewayPayment = async ({
  paymentMethod,
  gatewayCode,
  paidAmount
}) => {
  const trans = await db.transaction();
  let acceptedEvent = null;

  try {
    // 
    const paymentTransaction = await Transaction.findOne({
      where: {
        payment_method: paymentMethod,
        payment_gateway_code: String(gatewayCode)
      },
      transaction: trans,
      lock: trans.LOCK.UPDATE 
      // lock: ngăn chặn các giao dịch khác thay đổi dữ liệu trong khi giao dịch hiện tại đang được xử lý, đảm bảo tính nhất quán của dữ liệu.
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

    // Nếu giao dịch không ở trạng thái PENDING 
    if (paymentTransaction.status !== 'PENDING') {
      await trans.rollback();
      return {
        EM: `Transaction is already ${paymentTransaction.status}.`,
        EC: 409,
        DT: { status: paymentTransaction.status }
      };
    }

    // Kiểm tra xem số tiền thanh toán có khớp với số tiền của giao dịch hay không
    if (Number(paymentTransaction.amount) !== Number(paidAmount)) {
      await trans.rollback();
      return { EM: "Payment amount does not match the transaction.", EC: 400, DT: "" };
    }

    // Tìm ví đích dựa trên to_wallet_id của giao dịch thanh toán
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

      // Nếu giao dịch là DEPOSIT_10, xác nhận rằng công việc đang chờ thanh toán và giao dịch này là giao dịch khóa
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

      // Nếu tất cả các điều kiện đều thỏa mãn, tăng số dư của ví đích và đánh dấu giao dịch là SUCCESS.
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

      //////////////////////////////////////////////////////////
      // Tăng số dư của ví đích và đánh dấu giao dịch là SUCCESS
      await destinationWallet.increment(
        { balance: Number(paymentTransaction.amount) },
        { transaction: trans }
      );
      await paymentTransaction.update({ status: 'SUCCESS' }, { transaction: trans });
      const bidderRows = await Bid.findAll({
        where: { job_id: job.id },
        attributes: ['handyman_id'],
        transaction: trans
      });
      const acceptedTransition = await transitionJobToAccepted({
        job,
        selectedBid,
        depositTransaction: paymentTransaction,
        depositAmount: paymentTransaction.amount,
        changedByUserId: job.customer_id,
        sourceStatus: 'PENDING_DEPOSIT',
        transaction: trans
      });
      if (acceptedTransition.transitioned) {
        acceptedEvent = {
          userIds: [job.customer_id, ...bidderRows.map((row) => row.handyman_id)],
          payload: {
            job_id: job.id,
            current_status: 'ACCEPTED',
            acceptance_cycle: acceptedTransition.acceptanceCycle,
            selected_handyman_id: selectedBid.handyman_id,
            occurred_at: acceptedTransition.acceptedAt
          }
        };
      }
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
    if (acceptedEvent) {
      emitJobLifecycleEvent({
        event: JOB_LIFECYCLE_EVENTS.ACCEPTED,
        ...acceptedEvent
      });
    }
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
