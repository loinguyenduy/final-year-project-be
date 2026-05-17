import db from '../../../core/database/connection.js';
import User from '../models/User.model.js';
import KycRequest from '../models/KycRequest.model.js';

const submitCustomerKycService = async (userId, documents) => {
    const trans = await db.transaction();
    try {
        // Validate if user exists
        const user = await User.findByPk(userId, { transaction: trans });
        if (!user) {
            await trans.rollback();
            return { 
                EM: "User not found.", 
                EC: 404, 
                DT: "" 
            };
        }

        // Verify current KYC status to prevent duplicate submissions
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

        // Prepare data for bulk insert into KYC_Request
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

        await KycRequest.bulkCreate(kycDataToInsert, { transaction: trans });
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

const submitHandymanKycService = async (userId, documents) => {
    const trans = await db.transaction();
    try {
        const user = await User.findByPk(userId, { transaction: trans });
        if (!user) {
            await trans.rollback();
            return { 
                EM: "User not found.", 
                EC: 404, 
                DT: "" 
            };
        }

        if (user.role !== 'HANDYMAN') {
            await trans.rollback();
            return { 
                EM: "Only handymans can submit this type of KYC.", 
                EC: 403, 
                DT: "" 
            };
        }

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

        const kycDataToInsert = [
            { user_id: userId, document_type: 'CCCD_FRONT', document_url: documents.cccd_front, status: 'PENDING' },
            { user_id: userId, document_type: 'CCCD_BACK', document_url: documents.cccd_back, status: 'PENDING' },
            { user_id: userId, document_type: 'SELFIE', document_url: documents.portrait, status: 'PENDING' },
            { user_id: userId, document_type: 'CV', document_url: documents.cv, status: 'PENDING' },
            { user_id: userId, document_type: 'CERTIFICATE', document_url: documents.certificate, status: 'PENDING' }
        ];

        await KycRequest.bulkCreate(kycDataToInsert, { transaction: trans });
        await user.update({ kyc_status: 'PENDING' }, { transaction: trans });

        await trans.commit();
        return { 
            EM: "Handyman KYC documents submitted successfully.", 
            EC: 0, 
            DT: "" 
        };

    } catch (error) {
        await trans.rollback();
        console.log(">>> Error in submitHandymanKycService: ", error);
        return { 
            EM: "Internal server error while submitting KYC.", 
            EC: 500, 
            DT: "" 
        };
    }
};

export { submitCustomerKycService, submitHandymanKycService };      