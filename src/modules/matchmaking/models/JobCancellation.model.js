import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';

const JobCancellation = db.define('Job_Cancellation', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    cancelled_by_role: {
        type: DataTypes.ENUM('CUSTOMER', 'HANDYMAN'),
        allowNull: false
    },
    status_when_cancelled: {
        type: DataTypes.STRING(50),
        allowNull: false
    },
    cancellation_action: {
        type: DataTypes.ENUM('REOPEN_BIDDING', 'CANCEL_JOB', 'HANDYMAN_WITHDRAW'),
        allowNull: false
    },
    reason_code: {
        type: DataTypes.STRING(80),
        allowNull: false
    },
    reason_text: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    refund_amount: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: false
    },
    penalty_amount: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: false,
        defaultValue: 0
    }
}, {
    timestamps: true,
    indexes: [
        { name: 'job_cancellations_job_created_at', fields: ['job_id', 'createdAt'] },
        { name: 'job_cancellations_actor', fields: ['cancelled_by_user_id'] }
    ]
});

export default JobCancellation;
