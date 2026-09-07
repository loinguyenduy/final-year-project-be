import Transaction from "../models/Transaction.model.js";
import {
  PayOSConfigurationError,
  getPayOSInstance,
} from "../../../core/config/payos.config.js";
import Wallet from "../models/Wallet.model.js";
import User from '../../identity/models/User.model.js';
import HandymanProfile from '../../identity/models/HandymanProfile.model.js';
import {
  processExpiredGatewayPayment,
  processFailedGatewayPayment,
  processSuccessfulGatewayPayment
} from "./PaymentSettlement.service.js";

const getPublicBackendUrl = () => {
  const url = process.env.BACKEND_PUBLIC_URL
    || process.env.PUBLIC_BACKEND_URL
    || process.env.API_PUBLIC_URL;

  return url ? String(url).replace(/\/$/, '') : null;
};

const createTopUpLinkService = async (userId, amount, targetWallet = 'MAIN') => {
  let createdTransaction = null;

  try {
    const payOSInstance = getPayOSInstance();
    if (!amount || amount <= 0) {
      return {
        EM: "Invalid amount.",
        EC: 1,
        DT: "",
      };
    }

    const user = await User.findByPk(userId);
    if (!user) return { 
      EM: "User not found.", 
      EC: 404, 
      DT: "" 
    };

    
    let walletType = "CUSTOMER_MAIN";
    let txType = "TOP_UP";
    // Nếu là thợ và chọn ký quỹ, sẽ nạp vào ví HANDYMAN_ESCROW và loại giao dịch là BONDING_DEPOSIT
    if (user.role === 'HANDYMAN') {
        if (targetWallet === 'ESCROW') {
            walletType = "HANDYMAN_ESCROW";
            txType = "BONDING_DEPOSIT";
            if (Number(amount) !== 2000000) {
                return { 
                  EM: "Bonding deposit must be exactly 2,000,000 VND.", 
                  EC: 400, 
                  DT: "" 
                };
            }
            // Kiểm tra điều kiện C2 và trạng thái ký quỹ
            const profile = await HandymanProfile.findOne({ where: { user_id: userId } });

            if (!profile || profile.handyman_level !== 'C2') {
                return { 
                  EM: "You must pass KYC review (Level C2) before depositing the security bond.", 
                  EC: 403, 
                  DT: "" 
                };
            }

            if (profile.security_bond_status === 'PAID') {
                return { 
                  EM: "Security bond is already paid.", 
                  EC: 400, 
                  DT: "" 
                };
            }
            
        } else {
            walletType = "HANDYMAN_MAIN";
        }
    }

    const wallet = await Wallet.findOne({
      where: { user_id: userId, wallet_type: walletType },
    });

    if (!wallet) {
      return {
        EM: "Wallet not found for this user.",
        EC: 404,
        DT: "",
      };
    }

    if (wallet.is_blocked) {
      return {
        EM: "Your wallet is currently blocked.",
        EC: 403,
        DT: "",
      };
    }

    const orderCode = Number(
      String(Date.now()).slice(-6) + Math.floor(Math.random() * 100),
    );

    createdTransaction = await Transaction.create({
      amount: amount,
      transaction_type: txType,
      status: "PENDING",
      payment_method: "PAYOS",
      payment_gateway_code: String(orderCode),
      description: `Top up wallet for user ${userId}`,
      from_wallet_id: null,
      to_wallet_id: wallet.id,
    });

    const publicBackendUrl = getPublicBackendUrl();
    const returnUrl = process.env.PAYOS_TOPUP_RETURN_URL
      || (publicBackendUrl ? `${publicBackendUrl}/api/v1/fintech/payos-return` : null)
      || process.env.PAYOS_RETURN_URL;
    const cancelUrl = process.env.PAYOS_TOPUP_CANCEL_URL
      || (publicBackendUrl ? `${publicBackendUrl}/api/v1/fintech/payos-cancel` : null)
      || process.env.PAYOS_CANCEL_URL;

    if (!returnUrl || !cancelUrl) {
      throw new Error("Missing PayOS top-up returnUrl or cancelUrl.");
    }

    const bodyPayOS = {
      orderCode: orderCode,
      amount: Number(amount),
      description: `Topup ${String(orderCode)}`,
      returnUrl,
      cancelUrl,
    };

    // Create payment link using PayOS SDK
    const paymentLinkResponse =
      await payOSInstance.paymentRequests.create(bodyPayOS);

    return {
      EM: "Payment link created successfully.",
      EC: 0,
      DT: paymentLinkResponse.checkoutUrl,
    };
  } catch (error) {
    if (error instanceof PayOSConfigurationError) {
      return {
        EM: "PayOS is temporarily unavailable.",
        EC: 503,
        code: error.code,
        DT: "",
      };
    }
    console.error("PayOS top-up link creation failed:", error?.message || "unknown error");
    if (createdTransaction?.status === 'PENDING') {
      try {
        await createdTransaction.update({ status: 'FAILED' });
      } catch (updateError) {
        console.error("Unable to mark failed PayOS top-up transaction:", updateError);
      }
    }
    return {
      EM: "Internal server error.",
      EC: 500,
      DT: "",
    };
  }
};

// Xử lý webhook từ PayOS để xác nhận trạng thái thanh toán và cập nhật giao dịch tương ứng
const handlePayOSWebhookService = async (webhookData) => {
  try {
    const payOSInstance = getPayOSInstance();
    const verifiedData = await payOSInstance.webhooks.verify(webhookData);
    const { orderCode, amount, code } = verifiedData;

    if (code === "00") {
      return await processSuccessfulGatewayPayment({
        paymentMethod: 'PAYOS',
        gatewayCode: orderCode,
        paidAmount: amount
      });
    }

    return await processFailedGatewayPayment({
      paymentMethod: 'PAYOS',
      gatewayCode: orderCode
    });
  } catch (error) {
    if (error instanceof PayOSConfigurationError) {
      return { EM: "PayOS is temporarily unavailable.", EC: 503, code: error.code, DT: "" };
    }
    console.error("PayOS webhook processing failed:", error?.message || "unknown error");
    return {
      EM: "Invalid webhook data.",
      EC: 400,
      DT: "",
    };
  }
};

//trích xuất orderCode từ queryParams
const getPayOSOrderCode = (queryParams) => {
  const orderCode = queryParams?.orderCode || queryParams?.order_code;
  if (!orderCode || Number.isNaN(Number(orderCode))) {
    return null;
  }
  return Number(orderCode);
};

// Hàm handlePayOSReturnService xử lý callback từ PayOS sau khi người dùng hoàn tất thanh toán, xác nhận trạng thái thanh toán và cập nhật giao dịch tương ứng
const handlePayOSReturnService = async (queryParams) => {
  try {
    const payOSInstance = getPayOSInstance();
    const orderCode = getPayOSOrderCode(queryParams);
    if (!orderCode) {
      return { EM: "Missing or invalid PayOS orderCode.", EC: 400, DT: "" };
    }

    const paymentLink = await payOSInstance.paymentRequests.get(orderCode);
    const gatewayStatus = paymentLink.status;

    if (gatewayStatus === 'PAID') {
      const result = await processSuccessfulGatewayPayment({
        paymentMethod: 'PAYOS',
        gatewayCode: orderCode,
        paidAmount: Number(paymentLink.amountPaid || paymentLink.amount)
      });

      return {
        EM: result.EM,
        EC: result.EC,
        DT: {
          order_code: orderCode,
          gateway_status: gatewayStatus,
          settlement: result.DT
        }
      };
    }

    if (['CANCELLED', 'FAILED'].includes(gatewayStatus)) {
      const result = await processFailedGatewayPayment({
        paymentMethod: 'PAYOS',
        gatewayCode: orderCode
      });

      return {
        EM: result.EM,
        EC: result.EC,
        DT: {
          order_code: orderCode,
          gateway_status: gatewayStatus,
          settlement: result.DT
        }
      };
    }

    if (gatewayStatus === 'EXPIRED') {
      const result = await processExpiredGatewayPayment({
        paymentMethod: 'PAYOS',
        gatewayCode: orderCode
      });

      return {
        EM: result.EM,
        EC: result.EC,
        DT: {
          order_code: orderCode,
          gateway_status: gatewayStatus,
          settlement: result.DT
        }
      };
    }

    return {
      EM: "PayOS payment is not completed yet.",
      EC: 0,
      DT: {
        order_code: orderCode,
        gateway_status: gatewayStatus
      }
    };
  } catch (error) {
    if (error instanceof PayOSConfigurationError) {
      return { EM: "PayOS is temporarily unavailable.", EC: 503, code: error.code, DT: "" };
    }
    console.error("PayOS return processing failed:", error?.message || "unknown error");
    return { EM: "Unable to process PayOS return.", EC: 500, DT: "" };
  }
};

const handlePayOSCancelService = async (queryParams) => {
  try {
    const payOSInstance = getPayOSInstance();
    const orderCode = getPayOSOrderCode(queryParams);
    if (!orderCode) {
      return { EM: "Missing or invalid PayOS orderCode.", EC: 400, DT: "" };
    }

    const paymentLink = await payOSInstance.paymentRequests.get(orderCode);
    const gatewayStatus = paymentLink.status;

    if (gatewayStatus === 'PAID') {
      const result = await processSuccessfulGatewayPayment({
        paymentMethod: 'PAYOS',
        gatewayCode: orderCode,
        paidAmount: Number(paymentLink.amountPaid || paymentLink.amount)
      });

      return {
        EM: result.EM,
        EC: result.EC,
        DT: {
          order_code: orderCode,
          gateway_status: gatewayStatus,
          settlement: result.DT
        }
      };
    }

    if (gatewayStatus === 'PROCESSING') {
      return {
        EM: "PayOS payment is processing and cannot be marked as failed.",
        EC: 409,
        DT: {
          order_code: orderCode,
          gateway_status: gatewayStatus
        }
      };
    }

    if (gatewayStatus === 'EXPIRED') {
      const result = await processExpiredGatewayPayment({
        paymentMethod: 'PAYOS',
        gatewayCode: orderCode
      });

      return {
        EM: result.EM,
        EC: result.EC,
        DT: {
          order_code: orderCode,
          gateway_status: gatewayStatus,
          settlement: result.DT
        }
      };
    }

    const result = await processFailedGatewayPayment({
      paymentMethod: 'PAYOS',
      gatewayCode: orderCode
    });

    return {
      EM: "PayOS payment was cancelled by user.",
      EC: result.EC,
      DT: {
        order_code: orderCode,
        gateway_status: gatewayStatus,
        settlement: result.DT
      }
    };
  } catch (error) {
    if (error instanceof PayOSConfigurationError) {
      return { EM: "PayOS is temporarily unavailable.", EC: 503, code: error.code, DT: "" };
    }
    console.error("PayOS cancellation processing failed:", error?.message || "unknown error");
    return { EM: "Unable to process PayOS cancellation.", EC: 500, DT: "" };
  }
};

export {
  createTopUpLinkService,
  handlePayOSWebhookService,
  handlePayOSReturnService,
  handlePayOSCancelService
};
