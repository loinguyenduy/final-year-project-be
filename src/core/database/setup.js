import db from './connection.js';

import User from '../../modules/identity/models/User.model.js';
import AuthProvider from '../../modules/identity/models/AuthProvider.model.js';
import UserAddress from '../../modules/identity/models/UserAddress.model.js';
import KycRequest from '../../modules/identity/models/KycRequest.model.js';
import HandymanProfile from '../../modules/identity/models/HandymanProfile.model.js';
import Service from '../../modules/matchmaking/models/Service.model.js';
import Job from '../../modules/matchmaking/models/Job.model.js';
import Bid from '../../modules/matchmaking/models/Bid.model.js';
import JobStatusHistory from '../../modules/matchmaking/models/JobStatusHistory.model.js';
import Wallet from '../../modules/fintech/models/Wallet.model.js';
import Transaction from '../../modules/fintech/models/Transaction.model.js';
import Review from '../../modules/dispute/models/Review.model.js';
import EvidenceVault from '../../modules/fintech/models/EvidenceVault.model.js';
import EContract from '../../modules/fintech/models/EContract.model.js';
import RefreshToken from '../../modules/identity/models/RefreshToken.model.js';
import VerificationToken from '../../modules/identity/models/VerificationToken.model.js';

// A. Users
User.hasMany(AuthProvider, { foreignKey: 'user_id' });
AuthProvider.belongsTo(User, { foreignKey: 'user_id' });

User.hasMany(UserAddress, { foreignKey: 'user_id' });
UserAddress.belongsTo(User, { foreignKey: 'user_id' });

User.hasOne(HandymanProfile, { foreignKey: 'user_id', primaryKey: true });
HandymanProfile.belongsTo(User, { foreignKey: 'user_id' });

User.hasMany(KycRequest, { foreignKey: 'user_id' });
KycRequest.belongsTo(User, { foreignKey: 'user_id' });

User.hasMany(KycRequest, { foreignKey: 'reviewed_by_admin_id' });
KycRequest.belongsTo(User, { as: 'Admin', foreignKey: 'reviewed_by_admin_id' });

User.hasMany(Wallet, { foreignKey: 'user_id' });
Wallet.belongsTo(User, { foreignKey: 'user_id' });

User.hasMany(RefreshToken, { foreignKey: 'user_id' });
RefreshToken.belongsTo(User, { foreignKey: 'user_id' });

User.hasOne(VerificationToken, { foreignKey: 'user_id' });
VerificationToken.belongsTo(User, { foreignKey: 'user_id' });

// B. Jobs & Services
Service.hasMany(Job, { foreignKey: 'service_id' });
Job.belongsTo(Service, { foreignKey: 'service_id' });

User.hasMany(Job, { foreignKey: 'customer_id' });
Job.belongsTo(User, { as: 'Customer', foreignKey: 'customer_id' });

User.hasMany(Job, { foreignKey: 'selected_handyman_id' });
Job.belongsTo(User, { as: 'SelectedHandyman', foreignKey: 'selected_handyman_id' });

// C. Bids & Histories
Job.hasMany(Bid, { foreignKey: 'job_id' });
Bid.belongsTo(Job, { foreignKey: 'job_id' });

User.hasMany(Bid, { foreignKey: 'handyman_id' });
Bid.belongsTo(User, { foreignKey: 'handyman_id' });

Job.hasMany(JobStatusHistory, { foreignKey: 'job_id' });
JobStatusHistory.belongsTo(Job, { foreignKey: 'job_id' });

User.hasMany(JobStatusHistory, { foreignKey: 'changed_by_user_id' });
JobStatusHistory.belongsTo(User, { foreignKey: 'changed_by_user_id' });

// D. Dispute & Evidence
Job.hasMany(EvidenceVault, { foreignKey: 'job_id' });
EvidenceVault.belongsTo(Job, { foreignKey: 'job_id' });

User.hasMany(EvidenceVault, { foreignKey: 'uploader_id' });
EvidenceVault.belongsTo(User, { foreignKey: 'uploader_id' });

Job.hasOne(EContract, { foreignKey: 'job_id' });
EContract.belongsTo(Job, { foreignKey: 'job_id' });

Job.hasMany(Review, { foreignKey: 'job_id' });
Review.belongsTo(Job, { foreignKey: 'job_id' });

User.hasMany(Review, { foreignKey: 'reviewer_id' });
Review.belongsTo(User, { as: 'Reviewer', foreignKey: 'reviewer_id' });

User.hasMany(Review, { foreignKey: 'reviewee_id' });
Review.belongsTo(User, { as: 'Reviewee', foreignKey: 'reviewee_id' });

// E. FinTech Transactions
Wallet.hasMany(Transaction, { foreignKey: 'from_wallet_id' });
Transaction.belongsTo(Wallet, { as: 'FromWallet', foreignKey: 'from_wallet_id' });

Wallet.hasMany(Transaction, { foreignKey: 'to_wallet_id' });
Transaction.belongsTo(Wallet, { as: 'ToWallet', foreignKey: 'to_wallet_id' });

Job.hasMany(Transaction, { foreignKey: 'job_id' });
Transaction.belongsTo(Job, { foreignKey: 'job_id' });

const initDatabase = async () => {
    try {
        await db.authenticate();
        console.log('Connection to PostgreSQL has been established successfully.');
        await db.sync({ alter: true }); 
        console.log('All models were synchronized successfully.');
    } catch (error) {
        console.error('Unable to connect to the database:', error);
    }
};

export { db, initDatabase };