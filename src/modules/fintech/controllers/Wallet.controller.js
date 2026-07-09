import {
  createTopUpLinkService,
  handlePayOSCancelService,
  handlePayOSReturnService,
  handlePayOSWebhookService,
} from "../services/PayOS.service.js";
import { createVNPayTopUpLinkService, handleVNPayIPNService, handleVNPayReturnService } from "../services/VNPay.service.js";
import { getSystemWalletsService } from "../services/Wallet.service.js";

const handleTopUpWallet = async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount, payment_method, target_wallet } = req.body;

    if (!amount || !payment_method) {
      return res.status(400).json({ EM: "Amount and payment method are required.", EC: 400, DT: "" });
    }

    let result;
    if (payment_method === "PAYOS") {
      result = await createTopUpLinkService(userId, amount, target_wallet);
    } else if (payment_method === "VNPAY") {
      const ipAddr = req.headers["x-forwarded-for"] || req.socket.remoteAddress || '127.0.0.1';
      result = await createVNPayTopUpLinkService(userId, amount, ipAddr, target_wallet);
    } else {
      return res.status(400).json({ 
        EM: "Unsupported payment method.", 
        EC: 400, 
        DT: "" 
      });
    }
    
    return res.status(200).json({ 
      EM: result.EM, 
      EC: result.EC, 
      DT: result.DT 
    });
  } catch (error) {
    console.log("Error in handleTopUpWallet controller: ", error);
    return res.status(500).json({ 
      EM: "Internal server error.", 
      EC: 500, 
      DT: "" 
    });
  }
};

const handlePayOSWebhook = async (req, res) => {
  try {
    const webhookData = req.body;
    const result = await handlePayOSWebhookService(webhookData);

    if (result.EC === 0) {
      return res.status(200).json({ 
        success: true, 
        message: result.EM 
      });
    } else {
      return res.status(200).json({ 
        success: false, 
        message: result.EM 
      });
    }
  } catch (error) {
    console.error(">>> Error from Payment Controller:", error);
    return res.status(500).json({ 
      success: false, 
      message: "Internal server error" 
    });
  }
};

const getCallbackHttpStatus = (errorCode) => {
  if (errorCode === 0) return 200;
  if ([400, 404, 409].includes(errorCode)) return errorCode;
  return 500;
};

const handlePayOSReturn = async (req, res) => {
  try {
    const result = await handlePayOSReturnService(req.query);
    return res.status(getCallbackHttpStatus(result.EC)).json(result);
  } catch (error) {
    console.error(">>> Error in handlePayOSReturn controller:", error);
    return res.status(500).json({
      EM: "Unable to process PayOS return.",
      EC: 500,
      DT: ""
    });
  }
};

const handlePayOSCancel = async (req, res) => {
  try {
    const result = await handlePayOSCancelService(req.query);
    return res.status(getCallbackHttpStatus(result.EC)).json(result);
  } catch (error) {
    console.error(">>> Error in handlePayOSCancel controller:", error);
    return res.status(500).json({
      EM: "Unable to process PayOS cancellation.",
      EC: 500,
      DT: ""
    });
  }
};

const handleVNPayIPN = async (req, res) => {
  try {
    const vnpayParams = req.query; 
    const result = await handleVNPayIPNService(vnpayParams);
    return res.status(200).json(result);
  } catch (error) {
    console.log("Error in handleVNPayIPN controller: ", error);
    return res.status(200).json({ 
      RspCode: '99', 
      Message: 'Unknown error' 
    });
  }
};

const handleVNPayReturn = async (req, res) => {
  try {
    const result = await handleVNPayReturnService(req.query);
    const httpStatus = [400, 404, 409].includes(result.EC) ? result.EC : (result.EC === 0 ? 200 : 500);
    return res.status(httpStatus).json(result);
  } catch (error) {
    console.log("Error in handleVNPayReturn controller: ", error);
    return res.status(500).json({
      EM: "Unable to process VNPay return.",
      EC: 500,
      DT: ""
    });
  }
};

const handleGetSystemWallets = async (req, res) => {
  try {
    const result = await getSystemWalletsService();
    return res.status(result.EC === 0 ? 200 : 500).json(result);
  } catch (error) {
    console.log("Error in handleGetSystemWallets controller: ", error);
    return res.status(500).json({
      EM: "Internal server error.",
      EC: 500,
      DT: []
    });
  }
};

export {
  handleTopUpWallet,
  handlePayOSWebhook,
  handlePayOSReturn,
  handlePayOSCancel,
  handleVNPayIPN,
  handleVNPayReturn,
  handleGetSystemWallets
};
