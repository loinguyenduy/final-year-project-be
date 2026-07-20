import { DataTypes, Op } from 'sequelize';
import db from '../../../core/database/connection.js';

const JobWarranty = db.define('Job_Warranty', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    job_id: { type: DataTypes.UUID, allowNull: false },
    acceptance_cycle: {
        type: DataTypes.INTEGER,
        allowNull: false,
        validate: { min: 1 }
    },
    quote_id: { type: DataTypes.UUID, allowNull: false },
    contract_id: { type: DataTypes.UUID, allowNull: false },
    completion_request_id: { type: DataTypes.UUID, allowNull: false },
    customer_id: { type: DataTypes.UUID, allowNull: false },
    handyman_id: { type: DataTypes.UUID, allowNull: false },
    status: {
        type: DataTypes.ENUM(
            'ACTIVE',
            'CLAIM_PENDING',
            'REWORK_REQUIRED',
            'REWORK_CONFIRMATION_PENDING',
            'REVIEW_REQUIRED',
            'COMPLETED'
        ),
        allowNull: false,
        defaultValue: 'ACTIVE'
    },
    warranty_days: {
        type: DataTypes.INTEGER,
        allowNull: false,
        validate: { min: 1 }
    },
    started_at: { type: DataTypes.DATE, allowNull: false },
    ends_at: { type: DataTypes.DATE, allowNull: false },
    expiry_override_minutes: { type: DataTypes.INTEGER, allowNull: true, validate: { min: 1 } },
    total_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    handyman_immediate_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    platform_fee_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    warranty_held_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    warranty_released_amount: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: false,
        defaultValue: 0
    },
    released_at: { type: DataTypes.DATE, allowNull: true },
    release_transaction_id: { type: DataTypes.UUID, allowNull: true },
    warranty_refunded_amount: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: false,
        defaultValue: 0
    },
    refunded_at: { type: DataTypes.DATE, allowNull: true },
    refund_transaction_id: { type: DataTypes.UUID, allowNull: true },
    rework_cycle_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        validate: { min: 0 }
    }
}, {
    timestamps: true,
    indexes: [
        {
            name: 'job_warranties_job_cycle_unique',
            unique: true,
            fields: ['job_id', 'acceptance_cycle']
        },
        {
            name: 'job_warranties_refund_transaction_unique',
            unique: true,
            fields: ['refund_transaction_id'],
            where: { refund_transaction_id: { [Op.ne]: null } }
        },
        {
            name: 'job_warranties_completion_request_unique',
            unique: true,
            fields: ['completion_request_id']
        },
        {
            name: 'job_warranties_release_transaction_unique',
            unique: true,
            fields: ['release_transaction_id'],
            where: { release_transaction_id: { [Op.ne]: null } }
        },
        { name: 'job_warranties_release_candidates', fields: ['status', 'ends_at', 'released_at'] }
    ]
});

export default JobWarranty;
