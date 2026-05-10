import { createTopUpLinkService, handlePayOSWebhookService } from "../services/Wallet.service.js";

const handleTopUpWallet = async (req, res) => {
  try {
    const userId = req.user.id; 
    const { amount } = req.body;

    if (!amount) {
      return res.status(400).json({ EM: "Amount is required.", EC: 1, DT: "" });
    }

    const result = await createTopUpLinkService(userId, amount);
    
    return res.status(200).json({ EM: result.EM, EC: result.EC, DT: result.DT });
  } catch (error) {
    console.log("Error in handleTopUpWallet controller: ", error);
    return res.status(500).json({ EM: "Internal server error.", EC: 500, DT: "" });
  }
};

const handlePayOSWebhook = async (req, res) => {
  try {
    const webhookData = req.body;
    const result = await handlePayOSWebhookService(webhookData);

    // MẸO NHỎ ĐỂ LƯU WEBHOOK TRÊN WEB: Luôn trả về HTTP Status 200 cho PayOS
    if (result.EC === 0) {
      return res.status(200).json({ success: true, message: result.EM });
    } else {
      return res.status(400).json({ success: false, message: result.EM });
    }
  } catch (error) {
    console.error(">>> Error from Payment Controller:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export { handleTopUpWallet, handlePayOSWebhook };