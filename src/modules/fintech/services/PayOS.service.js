import Transaction from "../models/Transaction.model.js";
import payOSInstance from "../../../core/config/payos.config.js";
import db from "../../../core/database/connection.js";
import Wallet from "../models/Wallet.model.js";
import User from '../../identity/models/User.model.js';
import HandymanProfile from '../../identity/models/HandymanProfile.model.js';

const createTopUpLinkService = async (userId, amount, targetWallet = 'MAIN') => {
  try {
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
            // Kiểm tra điều kiện C1 và trạng thái ký quỹ
            const profile = await HandymanProfile.findOne({ where: { user_id: userId } });
            if (!profile || profile.handyman_level !== 'C1') {
                return { 
                  EM: "You must pass KYC review (Level C1) before depositing the security bond.", 
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

    await Transaction.create({
      amount: amount,
      transaction_type: txType,
      status: "PENDING",
      payment_method: "PAYOS",
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

    // Create payment link using PayOS SDK
    const paymentLinkResponse =
      await payOSInstance.paymentRequests.create(bodyPayOS);

    return {
      EM: "Payment link created successfully.",
      EC: 0,
      DT: paymentLinkResponse.checkoutUrl,
    };
  } catch (error) {
    console.log("Error in createTopUpLinkService: ", error);
    return {
      EM: "Internal server error.",
      EC: 500,
      DT: "",
    };
  }
};

const handlePayOSWebhookService = async (webhookData) => {
  const trans = await db.transaction();
  try {
    // Verify the webhook signature and extract the data
    const verifiedData = await payOSInstance.webhooks.verify(webhookData);
    const { orderCode, amount, code } = verifiedData;

    const pendingTransaction = await Transaction.findOne({
        where: { payment_gateway_code: String(orderCode) },
        transaction: trans,
    });

    if (code === "00") {
      if (pendingTransaction && pendingTransaction.status === "PENDING") {
          const wallet = await Wallet.findOne({
            where: { id: pendingTransaction.to_wallet_id },
            transaction: trans,
          });

          if (wallet) {
            const newBalance = parseFloat(wallet.balance) + parseFloat(pendingTransaction.amount);
            await wallet.update({ balance: newBalance }, { transaction: trans });
            await pendingTransaction.update({ status: "SUCCESS" }, { transaction: trans });
            
            if (pendingTransaction.transaction_type === 'BONDING_DEPOSIT') {
                await HandymanProfile.update(
                    { security_bond_status: 'PAID', handyman_level: 'C2' },
                    { where: { user_id: wallet.user_id }, transaction: trans }
                );
                console.log(`>>> Handyman ${wallet.user_id} bonded successfully. Upgraded to C2.`);
            }

            console.log(">>> PayOS Webhook: Wallet and Transaction updated successfully!");
          }
      }
    } else {
        if (pendingTransaction && pendingTransaction.status === "PENDING") {
            await pendingTransaction.update({ status: "FAILED" }, { transaction: trans });
            console.log(`>>> PayOS Webhook: Transaction ${orderCode} marked as FAILED due to code ${code}.`);
        }
    }

    await trans.commit();
    return {
      EM: "Webhook processed.",
      EC: 0,
      DT: "",
    };
  } catch (error) {
    await trans.rollback();
    console.error(">>> Webhook processing failed:", error);
    return {
      EM: "Invalid webhook data.",
      EC: 400,
      DT: "",
    };
  }
};

export { createTopUpLinkService, handlePayOSWebhookService };
