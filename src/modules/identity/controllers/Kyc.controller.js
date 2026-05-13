import { submitCustomerKycService } from "../services/Kyc.service.js";

const handleSubmitKyc = async (req, res) => {
    try {
        const userId = req.user.id;
        const files = req.files; // req.files contains the uploaded files from Cloudinary middleware

        if (!files || !files.cccd_front || !files.cccd_back || !files.portrait) {
            return res.status(400).json({
                EM: "Please provide all required documents: CCCD Front, CCCD Back, and Portrait.",
                EC: 1,
                DT: ""
            });
        }

        // Extract the URLs of the uploaded documents from Cloudinary response
        const documentUrls = {
            cccd_front: files.cccd_front[0].path,
            cccd_back: files.cccd_back[0].path,
            portrait: files.portrait[0].path
        };

        const result = await submitCustomerKycService(userId, documentUrls);

        return res.status(200).json({
            EM: result.EM,
            EC: result.EC,
            DT: result.DT
        });

    } catch (error) {
        console.log(">>> Error in handleSubmitKyc controller: ", error);
        return res.status(500).json({
            EM: "Internal server error.",
            EC: 500,
            DT: ""
        });
    }
};

export { handleSubmitKyc };