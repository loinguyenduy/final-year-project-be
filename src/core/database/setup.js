import db from './connection.js';

import User from '../../modules/identity/models/User.model.js';
import AuthProvider from '../../modules/identity/models/AuthProvider.model.js';
import UserAddress from '../../modules/identity/models/UserAddress.model.js';
import KycRequest from '../../modules/identity/models/KycRequest.model.js';
import HandymanProfile from '../../modules/identity/models/HandymanProfile.model.js';
import VerificationToken from '../../modules/identity/models/VerificationToken.model.js';
import RefreshToken from '../../modules/identity/models/RefreshToken.model.js';

import Province from '../../modules/matchmaking/models/Province.model.js';
import Ward from '../../modules/matchmaking/models/Ward.model.js';
import Service from '../../modules/matchmaking/models/Service.model.js';
import Job from '../../modules/matchmaking/models/Job.model.js';
import Bid from '../../modules/matchmaking/models/Bid.model.js';
import JobStatusHistory from '../../modules/matchmaking/models/JobStatusHistory.model.js';
import HandymanService from '../../modules/matchmaking/models/HandymanService.model.js';
import HandymanServiceArea from '../../modules/matchmaking/models/HandymanServiceArea.model.js';

import Wallet from '../../modules/fintech/models/Wallet.model.js';
import Transaction from '../../modules/fintech/models/Transaction.model.js';
import EvidenceVault from '../../modules/fintech/models/EvidenceVault.model.js';
import EContract from '../../modules/fintech/models/EContract.model.js';
import Review from '../../modules/dispute/models/Review.model.js';

// A. IDENTITY & USER ASSOCIATIONS
User.hasMany(AuthProvider, { foreignKey: 'user_id' });
AuthProvider.belongsTo(User, { foreignKey: 'user_id' });

User.hasMany(UserAddress, { foreignKey: 'user_id' });
UserAddress.belongsTo(User, { foreignKey: 'user_id' });

User.hasOne(HandymanProfile, { foreignKey: 'user_id', primaryKey: true });
HandymanProfile.belongsTo(User, { foreignKey: 'user_id' });

User.hasMany(KycRequest, { as: 'KycDocuments', foreignKey: 'user_id' });
KycRequest.belongsTo(User, { as: 'Owner', foreignKey: 'user_id' });

User.hasMany(KycRequest, { as: 'ReviewedRequests', foreignKey: 'reviewed_by_admin_id' });
KycRequest.belongsTo(User, { as: 'Admin', foreignKey: 'reviewed_by_admin_id' });

User.hasMany(RefreshToken, { foreignKey: 'user_id' });
RefreshToken.belongsTo(User, { foreignKey: 'user_id' });

User.hasOne(VerificationToken, { foreignKey: 'user_id' });
VerificationToken.belongsTo(User, { foreignKey: 'user_id' });

// B. GEOGRAPHY (PROVINCES & WARDS) ASSOCIATIONS
Province.hasMany(Ward, { foreignKey: 'province_code', sourceKey: 'province_code' });
Ward.belongsTo(Province, { foreignKey: 'province_code', targetKey: 'province_code' });

// Liên kết địa chỉ người dùng với hệ thống hành chính
Province.hasMany(UserAddress, { foreignKey: 'province_code', sourceKey: 'province_code' });
UserAddress.belongsTo(Province, { foreignKey: 'province_code', targetKey: 'province_code' });

Ward.hasMany(UserAddress, { foreignKey: 'ward_code', sourceKey: 'ward_code' });
UserAddress.belongsTo(Ward, { foreignKey: 'ward_code', targetKey: 'ward_code' });

// Liên kết Job với hệ thống hành chính để Matchmaking
Province.hasMany(Job, { foreignKey: 'province_code', sourceKey: 'province_code' });
Job.belongsTo(Province, { foreignKey: 'province_code', targetKey: 'province_code' });

Ward.hasMany(Job, { foreignKey: 'ward_code', sourceKey: 'ward_code' });
Job.belongsTo(Ward, { foreignKey: 'ward_code', targetKey: 'ward_code' });

// C. HANDYMAN SPECIALIZATIONS & SERVICE AREAS
User.hasMany(HandymanService, { as: 'Handyman_Services', foreignKey: 'handyman_id' });
HandymanService.belongsTo(User, { foreignKey: 'handyman_id' });
Service.hasMany(HandymanService, { foreignKey: 'service_id' });
HandymanService.belongsTo(Service, { foreignKey: 'service_id' });

User.hasMany(HandymanServiceArea, { as: 'Handyman_Service_Areas', foreignKey: 'handyman_id' });
HandymanServiceArea.belongsTo(User, { foreignKey: 'handyman_id' });
Province.hasMany(HandymanServiceArea, { foreignKey: 'province_code', sourceKey: 'province_code' });
HandymanServiceArea.belongsTo(Province, { foreignKey: 'province_code', targetKey: 'province_code' });
Ward.hasMany(HandymanServiceArea, { foreignKey: 'ward_code', sourceKey: 'ward_code' });
HandymanServiceArea.belongsTo(Ward, { foreignKey: 'ward_code', targetKey: 'ward_code' });

// D. MATCHMAKING (JOBS, SERVICES, BIDS)
Service.hasMany(Job, { foreignKey: 'service_id' });
Job.belongsTo(Service, { foreignKey: 'service_id' });

User.hasMany(Job, { foreignKey: 'customer_id' });
Job.belongsTo(User, { as: 'Customer', foreignKey: 'customer_id' });

User.hasMany(Job, { foreignKey: 'selected_handyman_id' });
Job.belongsTo(User, { as: 'SelectedHandyman', foreignKey: 'selected_handyman_id' });

Job.hasMany(Bid, { foreignKey: 'job_id' });
Bid.belongsTo(Job, { foreignKey: 'job_id' });

User.hasMany(Bid, { foreignKey: 'handyman_id' });
Bid.belongsTo(User, { foreignKey: 'handyman_id' });

Job.hasMany(JobStatusHistory, { foreignKey: 'job_id' });
JobStatusHistory.belongsTo(Job, { foreignKey: 'job_id' });

User.hasMany(JobStatusHistory, { foreignKey: 'changed_by_user_id' });
JobStatusHistory.belongsTo(User, { foreignKey: 'changed_by_user_id' });

// D. FINTECH (WALLET, TRANSACTION, EVIDENCE)
User.hasMany(Wallet, { foreignKey: 'user_id' });
Wallet.belongsTo(User, { foreignKey: 'user_id' });

Wallet.hasMany(Transaction, { foreignKey: 'from_wallet_id' });
Transaction.belongsTo(Wallet, { as: 'FromWallet', foreignKey: 'from_wallet_id' });

Wallet.hasMany(Transaction, { foreignKey: 'to_wallet_id' });
Transaction.belongsTo(Wallet, { as: 'ToWallet', foreignKey: 'to_wallet_id' });

Job.hasMany(Transaction, { foreignKey: 'job_id' });
Transaction.belongsTo(Job, { foreignKey: 'job_id' });

Job.hasMany(EvidenceVault, { foreignKey: 'job_id' });
EvidenceVault.belongsTo(Job, { foreignKey: 'job_id' });

User.hasMany(EvidenceVault, { foreignKey: 'uploader_id' });
EvidenceVault.belongsTo(User, { foreignKey: 'uploader_id' });

Job.hasOne(EContract, { foreignKey: 'job_id' });
EContract.belongsTo(Job, { foreignKey: 'job_id' });

// E. DISPUTE & REVIEWS
Job.hasMany(Review, { foreignKey: 'job_id' });
Review.belongsTo(Job, { foreignKey: 'job_id' });

User.hasMany(Review, { foreignKey: 'reviewer_id' });
Review.belongsTo(User, { as: 'Reviewer', foreignKey: 'reviewer_id' });

User.hasMany(Review, { foreignKey: 'reviewee_id' });
Review.belongsTo(User, { as: 'Reviewee', foreignKey: 'reviewee_id' });


const initDatabase = async () => {
    try {
        await db.authenticate();
        console.log('Connection to PostgreSQL has been established successfully.');
        // await db.sync({ alter: true });
        console.log('All models were synchronized successfully.');
    } catch (error) {
        console.error('Unable to connect to the database:', error);
    }
};

export { db, initDatabase };