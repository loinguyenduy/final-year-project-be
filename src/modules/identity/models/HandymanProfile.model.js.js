import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';

const HandymanProfile = db.define('Handyman_Profile', {
    kyc_status: { type: DataTypes.ENUM('UNVERIFIED', 'PENDING_REVIEW', 'VERIFIED', 'REJECTED'), defaultValue: 'UNVERIFIED' },
    bayesian_score: { type: DataTypes.DECIMAL(3, 2), defaultValue: 5.00 },
    total_jobs_completed: { type: DataTypes.INTEGER, defaultValue: 0 },
    security_bond_status: { type: DataTypes.ENUM('UNPAID', 'PAID', 'REFUNDED'), defaultValue: 'UNPAID' }
}, { timestamps: true });

export default HandymanProfile;