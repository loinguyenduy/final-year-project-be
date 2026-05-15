import { getPendingKycService, handleReviewKycService } from "../services/AdminKyc.service.js";

const getPendingKyc = async (req, res) => {
    try {
        const data = await getPendingKycService();
        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ EM: "Server error", EC: 500, DT: "" });
    }
};

const reviewKyc = async (req, res) => {
    try {
        const adminId = req.user.id; 
        const { userId, status, notes } = req.body;

        if (!userId || !status) {
            return res.status(400).json({ EM: "Missing userId or status.", EC: 1, DT: "" });
        }

        if (!['VERIFIED', 'REJECTED'].includes(status)) {
            return res.status(400).json({ EM: "Invalid status.", EC: 1, DT: "" });
        }

        const data = await handleReviewKycService(adminId, { userId, status, notes });
        return res.status(data.EC === 0 ? 200 : 400).json(data);
    } catch (error) {
        return res.status(500).json({ EM: "Server error", EC: 500, DT: "" });
    }
};

export { getPendingKyc, reviewKyc };