import { DataTypes, Op } from 'sequelize';
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
        type: DataTypes.ENUM(
            'REOPEN_BIDDING',
            'CANCEL_JOB',
            'HANDYMAN_WITHDRAW',
            'LIFECYCLE_CANCEL'
        ),
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
    acceptance_cycle: {
        type: DataTypes.INTEGER,
        allowNull: true,
        validate: { min: 1 }
    },
    classification: {
        type: DataTypes.ENUM(
            'CUSTOMER_FAULT',
            'HANDYMAN_FAULT',
            'NEUTRAL',
            'NEUTRAL_QUOTE_REJECTION',
            'DISPUTED'
        ),
        allowNull: true
    },
    resolution_mode: {
        type: DataTypes.ENUM(
            'AUTO_RESOLVE',
            'COUNTERPARTY_ACKNOWLEDGEMENT',
            'ADMIN_REVIEW'
        ),
        allowNull: true
    },
    status: {
        type: DataTypes.ENUM(
            'AWAITING_COUNTERPARTY',
            'REVIEW_REQUIRED',
            'RESOLVED',
            'SUPERSEDED'
        ),
        allowNull: true
    },
    deposit_amount: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: true
    },
    refund_amount: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: true
    },
    handyman_compensation_amount: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: true
    },
    platform_amount: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: true
    },
    penalty_amount: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: false,
        defaultValue: 0
    },
    requested_at: { type: DataTypes.DATE, allowNull: true },
    counterparty_responded_at: { type: DataTypes.DATE, allowNull: true },
    counterparty_response: {
        type: DataTypes.ENUM('CONFIRMED', 'REJECTED'),
        allowNull: true
    },
    counterparty_response_note: { type: DataTypes.TEXT, allowNull: true },
    counterparty_responded_by_user_id: { type: DataTypes.UUID, allowNull: true },
    resolved_at: { type: DataTypes.DATE, allowNull: true },
    resolved_by_user_id: { type: DataTypes.UUID, allowNull: true },
    resolution_note: { type: DataTypes.TEXT, allowNull: true },
    customer_refund_transaction_id: { type: DataTypes.UUID, allowNull: true },
    handyman_compensation_transaction_id: { type: DataTypes.UUID, allowNull: true },
    platform_transaction_id: { type: DataTypes.UUID, allowNull: true }
}, {
    timestamps: true,
    indexes: [
        { name: 'job_cancellations_job_created_at', fields: ['job_id', 'createdAt'] },
        { name: 'job_cancellations_actor', fields: ['cancelled_by_user_id'] },
        {
            name: 'job_cancellations_one_active_per_cycle',
            unique: true,
            fields: ['job_id', 'acceptance_cycle'],
            where: {
                acceptance_cycle: { [Op.ne]: null },
                status: { [Op.in]: ['AWAITING_COUNTERPARTY', 'REVIEW_REQUIRED'] }
            }
        },
        {
            name: 'job_cancellations_job_cycle_status',
            fields: ['job_id', 'acceptance_cycle', 'status']
        }
    ]
});

export default JobCancellation;
