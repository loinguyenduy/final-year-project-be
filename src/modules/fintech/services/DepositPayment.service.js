import crypto from 'crypto';
import moment from 'moment';
import qs from 'qs';
import db from '../../../core/database/connection.js';
import { sortObject } from '../../../core/utils/vnpay.util.js';
import payOSInstance from '../../../core/config/payos.config.js';
import Job from '../../matchmaking/models/Job.model.js';
import Bid from '../../matchmaking/models/Bid.model.js';
import JobStatusHistory from '../../matchmaking/models/JobStatusHistory.model.js';
import Transaction from '../models/Transaction.model.js';
import Wallet from '../models/Wallet.model.js';
import {
  cancelTransactionByIdService,
  expireTransactionByIdService
} from './PaymentSettlement.service.js';

const DEPOSIT_RATE = 0.1;
const DEPOSIT_EXPIRES_IN_MINUTES = 15;
const SUPPORTED_PAYMENT_METHODS = ['PAYOS', 'VNPAY'];

const calculateDepositAmount = (proposedPrice) => {
  return Math.round(Number(proposedPrice) * DEPOSIT_RATE);
};

const generateUniqueOrderCode = async (transaction) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const timePart = String(Date.now()).slice(-9);
    const randomPart = Math.floor(10 + Math.random() * 90);
    const orderCode = `${timePart}${randomPart}`;

    const existing = await Transaction.findOne({
      where: { payment_gateway_code: orderCode },
      attributes: ['id'],
      transaction
    });

    if (!existing) return orderCode;
  }

  throw new Error('Unable to generate a unique payment order code.');
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

    const depositAmount = calculateDepositAmount(validation.bid.proposed_price);

    return {
      EM: "Deposit summary retrieved successfully.",
      EC: 0,
      DT: {
        job_id: validation.job.id,
        bid_id: validation.bid.id,
        handyman_id: validation.bid.handyman_id,
        proposed_price: validation.bid.proposed_price,
        deposit_rate_percent: 10,
        deposit_amount: depositAmount,
        currency: 'VND',
        expires_in_minutes: DEPOSIT_EXPIRES_IN_MINUTES,
        supported_payment_methods: SUPPORTED_PAYMENT_METHODS
      }
    };
  } catch (error) {
    console.error(">>> Error in getDepositSummaryService:", error);
    return { EM: "Unable to retrieve deposit summary.", EC: 500, DT: "" };
  }
};

const createPayOSDepositLink = async ({
  orderCode,
  amount,
  expiresAt
}) => {
  const returnUrl = process.env.PAYOS_DEPOSIT_RETURN_URL || process.env.PAYOS_RETURN_URL;
  const cancelUrl = process.env.PAYOS_DEPOSIT_CANCEL_URL || process.env.PAYOS_CANCEL_URL;

  if (!returnUrl || !cancelUrl) {
    throw new Error('PayOS return URL or cancel URL is not configured.');
  }

  const response = await payOSInstance.paymentRequests.create({
    orderCode: Number(orderCode),
    amount,
    description: `Coc 10% ${orderCode}`,
    returnUrl,
    cancelUrl,
    expiredAt: Math.floor(expiresAt.getTime() / 1000)
  });

  return response.checkoutUrl;
};

const createVNPayDepositLink = ({
  orderCode,
  amount,
  ipAddr,
  expiresAt
}) => {
  const tmnCode = process.env.VNP_TMN_CODE;
  const secretKey = process.env.VNP_HASH_SECRET;
  const baseUrl = process.env.VNP_URL;
  const returnUrl = process.env.VNP_DEPOSIT_RETURN_URL || process.env.VNP_RETURN_URL;

  if (!tmnCode || !secretKey || !baseUrl || !returnUrl) {
    throw new Error('VNPay configuration is incomplete.');
  }

  const createDate = moment().format('YYYYMMDDHHmmss');
  let vnpParams = {
    vnp_Version: '2.1.0',
    vnp_Command: 'pay',
    vnp_TmnCode: tmnCode,
    vnp_Locale: 'vn',
    vnp_CurrCode: 'VND',
    vnp_TxnRef: orderCode,
    vnp_OrderInfo: `Deposit 10 percent for job`,
    vnp_OrderType: 'other',
    vnp_Amount: amount * 100,
    vnp_ReturnUrl: returnUrl,
    vnp_IpAddr: ipAddr || '127.0.0.1',
    vnp_CreateDate: createDate,
    vnp_ExpireDate: moment(expiresAt).format('YYYYMMDDHHmmss')
  };

  vnpParams = sortObject(vnpParams);
  const signData = qs.stringify(vnpParams, { encode: false });
  const signed = crypto
    .createHmac('sha512', secretKey)
    .update(Buffer.from(signData, 'utf-8'))
    .digest('hex');

  vnpParams.vnp_SecureHash = signed;
  return `${baseUrl}?${qs.stringify(vnpParams, { encode: false })}`;
};

const createDepositPaymentService = async (
  customerId,
  jobId,
  bidId,
  paymentMethod,
  ipAddr
) => {
  const normalizedPaymentMethod = String(paymentMethod || '').toUpperCase();

  if (!SUPPORTED_PAYMENT_METHODS.includes(normalizedPaymentMethod)) {
    return {
      EM: "payment_method must be PAYOS or VNPAY.",
      EC: 400,
      DT: ""
    };
  }

  const trans = await db.transaction();
  let paymentTransaction;

  try {
    const validation = await validateJobAndBid(customerId, jobId, bidId, {
      transaction: trans,
      lock: trans.LOCK.UPDATE
    });

    if (validation.error) {
      await trans.rollback();
      return validation.error;
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
      return {
        EM: "SYSTEM_ESCROW wallet is not initialized.",
        EC: 500,
        DT: ""
      };
    }

    const depositAmount = calculateDepositAmount(validation.bid.proposed_price);
    if (!Number.isSafeInteger(depositAmount) || depositAmount <= 0) {
      await trans.rollback();
      return {
        EM: "The calculated deposit amount is invalid.",
        EC: 400,
        DT: ""
      };
    }

    const expiresAt = new Date(
      Date.now() + DEPOSIT_EXPIRES_IN_MINUTES * 60 * 1000
    );
    const orderCode = await generateUniqueOrderCode(trans);

    paymentTransaction = await Transaction.create({
      amount: depositAmount,
      transaction_type: 'DEPOSIT_10',
      status: 'PENDING',
      payment_method: normalizedPaymentMethod,
      payment_gateway_code: orderCode,
      description: `10% deposit for job ${jobId} and bid ${bidId}`,
      from_wallet_id: null,
      to_wallet_id: systemEscrowWallet.id,
      job_id: jobId,
      expires_at: expiresAt
    }, { transaction: trans });

    await validation.job.update({
      current_status: 'PENDING_DEPOSIT',
      selected_bid_id: validation.bid.id,
      deposit_transaction_id: paymentTransaction.id
    }, { transaction: trans });

    await JobStatusHistory.create({
      job_id: jobId,
      changed_by_user_id: customerId,
      old_status: 'BIDDING',
      new_status: 'PENDING_DEPOSIT'
    }, { transaction: trans });

    await trans.commit();

    let checkoutUrl;
    if (normalizedPaymentMethod === 'PAYOS') {
      checkoutUrl = await createPayOSDepositLink({
        orderCode,
        amount: depositAmount,
        expiresAt
      });
    } else {
      checkoutUrl = createVNPayDepositLink({
        orderCode,
        amount: depositAmount,
        ipAddr,
        expiresAt
      });
    }

    return {
      EM: "Deposit payment link created successfully.",
      EC: 0,
      DT: {
        transaction_id: paymentTransaction.id,
        job_id: jobId,
        bid_id: bidId,
        payment_method: normalizedPaymentMethod,
        amount: depositAmount,
        currency: 'VND',
        status: 'PENDING',
        checkout_url: checkoutUrl,
        expires_at: expiresAt
      }
    };
  } catch (error) {
    if (!trans.finished) {
      await trans.rollback();
    }

    if (paymentTransaction?.id) {
      await cancelTransactionByIdService(paymentTransaction.id, customerId);
    }

    console.error(">>> Error in createDepositPaymentService:", error);
    return {
      EM: "Unable to create the deposit payment link. The job was returned to BIDDING.",
      EC: 502,
      DT: ""
    };
  }
};

const getDepositPaymentStatusService = async (
  customerId,
  jobId,
  transactionId
) => {
  try {
    let paymentTransaction = await Transaction.findOne({
      where: {
        id: transactionId,
        job_id: jobId,
        transaction_type: 'DEPOSIT_10'
      }
    });

    if (!paymentTransaction) {
      return { EM: "Deposit transaction not found.", EC: 404, DT: "" };
    }

    const job = await Job.findByPk(jobId);
    if (!job) {
      return { EM: "Job not found.", EC: 404, DT: "" };
    }
    if (job.customer_id !== customerId) {
      return { EM: "You do not have permission to view this deposit.", EC: 403, DT: "" };
    }

    if (
      paymentTransaction.status === 'PENDING'
      && paymentTransaction.expires_at
      && new Date(paymentTransaction.expires_at) <= new Date()
    ) {
      await expireTransactionByIdService(paymentTransaction.id);
      paymentTransaction = await Transaction.findByPk(paymentTransaction.id);
      await job.reload();
    }

    return {
      EM: "Deposit payment status retrieved successfully.",
      EC: 0,
      DT: {
        transaction_id: paymentTransaction.id,
        transaction_status: paymentTransaction.status,
        transaction_type: paymentTransaction.transaction_type,
        payment_method: paymentTransaction.payment_method,
        amount: paymentTransaction.amount,
        expires_at: paymentTransaction.expires_at,
        job_id: job.id,
        job_status: job.current_status,
        selected_bid_id: job.selected_bid_id,
        accepted_at: job.accepted_at,
        contact_unlocked_at: job.contact_unlocked_at
      }
    };
  } catch (error) {
    console.error(">>> Error in getDepositPaymentStatusService:", error);
    return { EM: "Unable to retrieve deposit payment status.", EC: 500, DT: "" };
  }
};

const cancelDepositPaymentService = async (
  customerId,
  jobId,
  transactionId
) => {
  try {
    const paymentTransaction = await Transaction.findOne({
      where: {
        id: transactionId,
        job_id: jobId,
        transaction_type: 'DEPOSIT_10'
      }
    });

    if (!paymentTransaction) {
      return { EM: "Deposit transaction not found.", EC: 404, DT: "" };
    }

    const job = await Job.findByPk(jobId);
    if (!job) {
      return { EM: "Job not found.", EC: 404, DT: "" };
    }
    if (job.customer_id !== customerId) {
      return { EM: "You do not have permission to cancel this deposit.", EC: 403, DT: "" };
    }
    if (paymentTransaction.status !== 'PENDING') {
      return {
        EM: "Only a pending deposit transaction can be cancelled.",
        EC: 409,
        DT: { status: paymentTransaction.status }
      };
    }

    if (paymentTransaction.payment_method !== 'PAYOS') {
      return {
        EM: "VNPay cancellation is handled by VNPay IPN. If the payment page is abandoned, it will expire automatically.",
        EC: 400,
        DT: ""
      };
    }

    const orderCode = Number(paymentTransaction.payment_gateway_code);
    const paymentLink = await payOSInstance.paymentRequests.get(orderCode);

    if (['PAID', 'PROCESSING'].includes(paymentLink.status)) {
      return {
        EM: "The payment is already paid or processing and cannot be cancelled.",
        EC: 409,
        DT: { gateway_status: paymentLink.status }
      };
    }

    if (!['CANCELLED', 'EXPIRED', 'FAILED'].includes(paymentLink.status)) {
      await payOSInstance.paymentRequests.cancel(
        orderCode,
        'Customer cancelled deposit payment'
      );
    }

    const result = await cancelTransactionByIdService(
      paymentTransaction.id,
      customerId
    );

    return {
      EM: "Deposit payment cancelled. Job returned to BIDDING.",
      EC: result.EC,
      DT: result.DT
    };
  } catch (error) {
    console.error(">>> Error in cancelDepositPaymentService:", error);
    return {
      EM: "Unable to cancel deposit payment.",
      EC: 502,
      DT: ""
    };
  }
};

export {
  getDepositSummaryService,
  createDepositPaymentService,
  getDepositPaymentStatusService,
  cancelDepositPaymentService,
  calculateDepositAmount
};
