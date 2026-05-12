import db from '../../../core/database/connection.js';
import User from '../models/User.model.js';
import KycRequest from '../models/KycRequest.model.js';

const submitCustomerKycService = async (userId, documents) => {
    const trans = await db.transaction();
    try {
        // 1. Kiểm tra User
        const user = await User.findByPk(userId, { transaction: trans });
        if (!user) {
            await trans.rollback();
            return { 
              EM: "User not found.", 
              EC: 404, 
              DT: "" 
            };
        }

        // 2. Chặn nếu User đang chờ duyệt hoặc đã duyệt
        if (user.kyc_status === 'PENDING') {
            await trans.rollback();
            return { 
              EM: "Your KYC request is already pending review.", 
              EC: 400, 
              DT: "" 
            };
        }
        if (user.kyc_status === 'VERIFIED') {
            await trans.rollback();
            return { 
              EM: "Your account is already verified.", 
              EC: 400, 
              DT: "" 
            };
        }

        // 3. Chuẩn bị dữ liệu để bulkCreate (tạo nhiều bản ghi 1 lúc)
        const kycDataToInsert = [
            {
                user_id: userId,
                document_type: 'CCCD_FRONT',
                document_url: documents.cccd_front,
                status: 'PENDING'
            },
            {
                user_id: userId,
                document_type: 'CCCD_BACK',
                document_url: documents.cccd_back,
                status: 'PENDING'
            },
            {
                user_id: userId,
                document_type: 'SELFIE',
                document_url: documents.portrait,
                status: 'PENDING'
            }
        ];

        // 4. Lưu vào bảng KYC_Request
        await KycRequest.bulkCreate(kycDataToInsert, { transaction: trans });

        // 5. Cập nhật trạng thái User thành PENDING
        await user.update({ kyc_status: 'PENDING' }, { transaction: trans });

        await trans.commit();
        return { 
          EM: "KYC documents submitted successfully.", 
          EC: 0, 
          DT: "" 
        };

    } catch (error) {
        await trans.rollback();
        console.log(">>> Error in submitCustomerKycService: ", error);
        return { 
          EM: "Internal server error while submitting KYC.", 
          EC: 500, 
          DT: "" 
        };
    }
};

export { submitCustomerKycService };