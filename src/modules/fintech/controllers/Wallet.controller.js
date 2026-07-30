import {
  createTopUpLinkService,
  handlePayOSCancelService,
  handlePayOSReturnService,
  handlePayOSWebhookService,
} from "../services/PayOS.service.js";
import { getSystemWalletsService } from "../services/Wallet.service.js";

const getTopUpHttpStatus = (errorCode) => {
  if (errorCode === 0) return 200;
  if ([1, 400].includes(errorCode)) return 400;
  if ([403, 404].includes(errorCode)) return errorCode;
  if (errorCode === 503) return 503;
  return 500;
};

const handleTopUpWallet = async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount, payment_method = "PAYOS", target_wallet } = req.body;

    if (!amount) {
      return res.status(400).json({ EM: "Amount is required.", EC: 400, DT: "" });
    }

    if (String(payment_method).toUpperCase() !== "PAYOS") {
      return res.status(400).json({ 
        EM: "Unsupported payment method. PayOS is the only supported gateway.", 
        EC: 400, 
        DT: "" 
      });
    }

    const result = await createTopUpLinkService(userId, amount, target_wallet);
    
    return res.status(getTopUpHttpStatus(result.EC)).json({ 
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

    if (result.EC === 503) {
      return res.status(503).json({
        success: false,
        message: result.EM,
        code: result.code,
      });
    } else if (result.EC === 0) {
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
  if ([400, 404, 409, 503].includes(errorCode)) return errorCode;
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
  handleGetSystemWallets
};
