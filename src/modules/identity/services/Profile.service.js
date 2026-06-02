import User from '../models/User.model.js';
import HandymanProfile from '../models/HandymanProfile.model.js';
import Wallet from '../../fintech/models/Wallet.model.js';
import AuthProvider from '../models/AuthProvider.model.js';

const getDetailedProfileService = async (userId) => {
    try {
        const userProfile = await User.findByPk(userId, {
            attributes: ['id', 'full_name', 'email', 'phone_number', 'role', 'is_active', 'avatar_url', 'is_email_verified', 'kyc_status'],
            include: [
                {
                    model: HandymanProfile,
                    attributes: ['handyman_level', 'bayesian_score', 'total_jobs_completed', 'security_bond_status']
                },
                {
                    model: Wallet,
                    attributes: ['id', 'wallet_type', 'balance', 'currency', 'is_blocked']
                },
                {
                    model: AuthProvider,
                    attributes: ['id', 'provider']
                }
            ]
        });

        if (!userProfile) {
            return {
                EM: "User profile not found.",
                EC: 404,
                DT: ""
            };
        }

        return {
            EM: "Fetch user profile successfully.",
            EC: 0,
            DT: userProfile
        };

    } catch (error) {
        console.error(">>> Error in getDetailedProfileService: ", error);
        return {
            EM: "Internal server error while fetching profile.",
            EC: 500,
            DT: ""
        };
    }
};

export { getDetailedProfileService };