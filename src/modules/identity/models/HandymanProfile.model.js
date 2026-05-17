import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';

const HandymanProfile = db.define('Handyman_Profile', {
    bayesian_score: { 
        type: DataTypes.DECIMAL(3, 2), 
        defaultValue: 5.00 
    },
    user_id: { 
        type: DataTypes.UUID, 
        allowNull: false,
    },
    total_jobs_completed: { 
        type: DataTypes.INTEGER, 
        defaultValue: 0 
    },
    security_bond_status: { 
        type: DataTypes.ENUM('UNPAID', 'PAID', 'REFUNDED'), 
        defaultValue: 'UNPAID' 
    },
    handyman_level: { 
        type: DataTypes.ENUM('C0', 'C1', 'C2', 'C3'), 
        defaultValue: 'C0' 
    },
}, { timestamps: true });

export default HandymanProfile;