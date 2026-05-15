import db from '../../../core/database/connection.js';
import User from '../../identity/models/User.model.js';
import KycRequest from '../../identity/models/KycRequest.model.js';
import HandymanProfile from '../../identity/models/HandymanProfile.model.js';

const getPendingKycService = async () => {
    try {
        const users = await User.findAll({
            where: { kyc_status: 'PENDING' },
            include: [{ model: KycRequest, where: { status: 'PENDING' } }],
            attributes: ['id', 'full_name', 'email', 'role', 'phone_number']
        });
        return { EM: "Fetch pending KYC successfully.", EC: 0, DT: users };
    } catch (error) {
        console.log(error);
        return { EM: "Error fetching data.", EC: 500, DT: [] };
    }
};

const handleReviewKycService = async (adminId, data) => {
    const { userId, status, notes } = data;
    const trans = await db.transaction();
    try {
        const user = await User.findByPk(userId, { transaction: trans });
        if (!user) throw new Error("User not found");

        await user.update({ kyc_status: status }, { transaction: trans });

        const dbStatus = status === 'VERIFIED' ? 'APPROVED' : 'REJECTED';
        await KycRequest.update(
            { 
                status: dbStatus, 
                admin_notes: notes, 
                reviewed_by_admin_id: adminId,
                reviewed_at: new Date()
            },
            { where: { user_id: userId, status: 'PENDING' }, transaction: trans }
        );

        if (user.role === 'HANDYMAN' && status === 'VERIFIED') {
            await HandymanProfile.update(
                { handyman_level: 'C2' },
                { where: { user_id: userId }, transaction: trans }
            );
        }

        await trans.commit();
        return { EM: `User has been ${status.toLowerCase()} successfully.`, EC: 0, DT: "" };
    } catch (error) {
        await trans.rollback();
        return { EM: error.message, EC: 500, DT: "" };
    }
};

export { getPendingKycService, handleReviewKycService };