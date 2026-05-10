import Wallet from '../models/Wallet.model.js';
import Transaction from '../models/Transaction.model.js';
import payOSInstance from '../../../core/config/payos.config.js';
import db from '../../../core/database/connection.js';

const initializeUserWallets = async (userId, role, transaction = null) => {
  try {
    const options = transaction ? { transaction } : {};

    const existingWallet = await Wallet.findOne({
      where: { user_id: userId },
      ...options,
    });

    if (existingWallet) {
      return { EM: "Wallets already exist for this user.", EC: 400, DT: "" };
    }

    const walletsToCreate = [];

    if (role === "CUSTOMER") {
      walletsToCreate.push({ user_id: userId, wallet_type: "CUSTOMER_MAIN", balance: 0.0 });
    } else if (role === "HANDYMAN") {
      walletsToCreate.push(
        { user_id: userId, wallet_type: "HANDYMAN_MAIN", balance: 0.0 },
        { user_id: userId, wallet_type: "HANDYMAN_ESCROW", balance: 0.0 }
      );
    } else if (role === "ADMIN") {
      walletsToCreate.push(
        { user_id: userId, wallet_type: "SYSTEM_PROFIT", balance: 0.0 },
        { user_id: userId, wallet_type: "SYSTEM_ESCROW", balance: 0.0 }
      );
    }

    if (walletsToCreate.length > 0) {
      await Wallet.bulkCreate(walletsToCreate, options);
    }

    return { EM: "Wallets initialized successfully.", EC: 0, DT: "" };
  } catch (error) {
    console.error(">>> Error in initializeUserWallets:", error);
    return { EM: "An error occurred while initializing wallets.", EC: 500, DT: "" };
  }
};

const createTopUpLinkService = async (userId, amount) => {
  try {
    if (!amount || amount <= 0) {
      return { EM: "Invalid amount.", EC: 1, DT: "" };
    }

    const wallet = await Wallet.findOne({
      where: { user_id: userId, wallet_type: "CUSTOMER_MAIN" },
    });

    if (!wallet) {
      return { EM: "Wallet not found for this user.", EC: 404, DT: "" };
    }

    if (wallet.is_blocked) {
      return { EM: "Your wallet is currently blocked.", EC: 403, DT: "" };
    }

    const orderCode = Number(String(Date.now()).slice(-6) + Math.floor(Math.random() * 100));

    await Transaction.create({
      amount: amount,
      transaction_type: "TOP_UP",
      status: "PENDING",
      payment_gateway_code: String(orderCode),
      description: `Top up wallet for user ${userId}`,
      from_wallet_id: null,
      to_wallet_id: wallet.id,
    });

    const bodyPayOS = {
      orderCode: orderCode,
      amount: Number(amount),
      description: `Topup ${String(orderCode)}`,
      returnUrl: process.env.PAYOS_RETURN_URL,
      cancelUrl: process.env.PAYOS_CANCEL_URL,
    };

    // ÁP DỤNG CÚ PHÁP PROJECT CŨ 100%
    const paymentLinkResponse = await payOSInstance.paymentRequests.create(bodyPayOS);

    return { EM: "Payment link created successfully.", EC: 0, DT: paymentLinkResponse.checkoutUrl };
  } catch (error) {
    console.log("Error in createTopUpLinkService: ", error);
    return { EM: "Internal server error.", EC: 500, DT: "" };
  }
};

const handlePayOSWebhookService = async (webhookData) => {
  const trans = await db.transaction();
  try {
    // ÁP DỤNG CÚ PHÁP PROJECT CŨ ĐỂ VERIFY
    const verifiedData = await payOSInstance.webhooks.verify(webhookData);
    const { orderCode, amount, code } = verifiedData;

    if (code === "00") {
      console.log(`>>> Webhook verified. Success payment for OrderCode: ${orderCode}`);
      
      const pendingTransaction = await Transaction.findOne({
        where: { payment_gateway_code: String(orderCode), transaction_type: "TOP_UP" },
        transaction: trans,
      });

      if (pendingTransaction) {
        if (pendingTransaction.status === "PENDING") {
          const wallet = await Wallet.findOne({
            where: { id: pendingTransaction.to_wallet_id },
            transaction: trans,
          });

          if (wallet) {
            const newBalance = parseFloat(wallet.balance) + parseFloat(pendingTransaction.amount);
            await wallet.update({ balance: newBalance }, { transaction: trans });
            await pendingTransaction.update({ status: "SUCCESS" }, { transaction: trans });
            console.log(">>> Wallet and Transaction updated successfully!");
          } else {
            console.warn(">>> Destination wallet not found.");
          }
        } else {
          console.warn(">>> Transaction already processed.");
        }
      } else {
        console.warn(">>> Transaction not found for OrderCode:", orderCode);
      }
    }

    await trans.commit();
    return { EM: "Webhook processed.", EC: 0, DT: "" };
  } catch (error) {
    await trans.rollback();
    console.error(">>> Webhook processing failed:", error);
    // Vẫn trả về EC: 400 theo ý bạn
    return { EM: "Invalid webhook data.", EC: 400, DT: "" };
  }
};

export { initializeUserWallets, createTopUpLinkService, handlePayOSWebhookService };