import {
  createTopUpLinkService,
  handlePayOSWebhookService,
} from "../services/PayOS.service.js";
import { createVNPayTopUpLinkService, handleVNPayIPNService } from "../services/VNPay.service.js";

const handleTopUpWallet = async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount, paymentMethod } = req.body;

    if (!amount || !paymentMethod) {
      return res.status(400).json({
        EM: "Amount and payment method are required.",
        EC: 400,
        DT: "",
      });
    }

    let result;
    if (paymentMethod === "PAYOS") {
      result = await createTopUpLinkService(userId, amount);
    } else if (paymentMethod === "VNPAY") {
      const ipAddr = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
      result = await createVNPayTopUpLinkService(userId, amount, ipAddr);
    } else {
      return res
        .status(400)
        .json({ 
          EM: "Unsupported payment method.", 
          EC: 400, 
          DT: "" 
        });
    }
    return res
      .status(200)
      .json({ 
        EM: result.EM, 
        EC: result.EC, 
        DT: result.DT 
      });
  } catch (error) {
    console.log("Error in handleTopUpWallet controller: ", error);
    return res
      .status(500)
      .json({ 
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
      return res.status(200).json({ success: true, message: result.EM });
    } else {
      return res.status(400).json({ success: false, message: result.EM });
    }
  } catch (error) {
    console.error(">>> Error from Payment Controller:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

const handleVNPayIPN = async (req, res) => {
  try {
    const vnpayParams = req.query; 
    
    const result = await handleVNPayIPNService(vnpayParams);

    return res.status(200).json(result);
  } catch (error) {
    console.log("Error in handleVNPayIPN controller: ", error);
    return res.status(200).json({ RspCode: '99', Message: 'Unknown error' });
  }
};

export { handleTopUpWallet, handlePayOSWebhook, handleVNPayIPN };
