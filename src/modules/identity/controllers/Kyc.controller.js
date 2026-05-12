import { submitCustomerKycService } from "../services/Kyc.service.js";

const handleSubmitKyc = async (req, res) => {
    try {
        const userId = req.user.id;
        const files = req.files; // Multer gán dữ liệu vào req.files

        // 1. Kiểm tra xem có đủ 3 loại file không
        if (!files || !files.cccd_front || !files.cccd_back || !files.portrait) {
            return res.status(400).json({
                EM: "Please provide all required documents: CCCD Front, CCCD Back, and Portrait.",
                EC: 1,
                DT: ""
            });
        }

        // 2. Lấy URL an toàn (path) do Cloudinary trả về
        // Vì mỗi field maxCount là 1, nên mảng luôn có phần tử ở vị trí [0]
        const documentUrls = {
            cccd_front: files.cccd_front[0].path,
            cccd_back: files.cccd_back[0].path,
            portrait: files.portrait[0].path
        };

        // 3. Gọi Service xử lý
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