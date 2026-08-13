import { DataTypes, Op } from 'sequelize';
import db from '../../../core/database/connection.js';

const Transaction = db.define('Transaction', {
    id: { 
        type: DataTypes.UUID, 
        defaultValue: DataTypes.UUIDV4, 
        primaryKey: true 
    },
    amount: { 
        type: DataTypes.DECIMAL(15, 2), 
        allowNull: false 
    },
    transaction_type: { 
        type: DataTypes.ENUM(
            'TOP_UP',
            'WITHDRAW',
            'DEPOSIT_10',
            'LOCK_100',
            'PLATFORM_FEE_10',
            'WARRANTY_HOLD_20',
            'DISBURSE_80',
            'PLATFORM_SERVICE_FEE',
            'WARRANTY_RESERVE_HOLD',
            'HANDYMAN_PARTIAL_RELEASE',
            'WARRANTY_RELEASE',
            'WARRANTY_REFUND',
            'REFUND',
            'DEPOSIT_REFUND',
            'BONDING_DEPOSIT',
            'CANCELLATION_REFUND',
            'CANCELLATION_COMPENSATION',
            'CANCELLATION_PLATFORM_FEE',
            'SERVICE_REMAINING_PAYMENT'
        ),
        allowNull: false 
    },
    status: { 
        type: DataTypes.ENUM('PENDING', 'SUCCESS', 'FAILED', 'EXPIRED'), 
        defaultValue: 'PENDING' 
    },
    payment_method: { 
        type: DataTypes.ENUM('PAYOS', 'VNPAY', 'CASH', 'INTERNAL'),
        allowNull: true
    },
    payment_gateway_code: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: 'Store the external payment gateway order code'
    },
    description: {
        type: DataTypes.STRING(255),
        allowNull: true
    },
    expires_at: {
        type: DataTypes.DATE,
        allowNull: true
    },
    reference_transaction_id: {
        type: DataTypes.UUID,
        allowNull: true
    },
    cancellation_id: {
        type: DataTypes.UUID,
        allowNull: true
    },
    quote_id: {
        type: DataTypes.UUID,
        allowNull: true
    },
    acceptance_cycle: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    payer_user_id: {
        type: DataTypes.UUID,
        allowNull: true
    },
    completion_request_id: {
        type: DataTypes.UUID,
        allowNull: true
    },
    warranty_id: {
        type: DataTypes.UUID,
        allowNull: true
    },
    warranty_completion_request_id: {
        type: DataTypes.UUID,
        allowNull: true
    },
    idempotency_key: {
        type: DataTypes.STRING(160),
        allowNull: true
    }
}, {
    timestamps: true,
    indexes: [
        {
            name: 'transactions_gateway_code_unique',
            unique: true,
            fields: ['payment_method', 'payment_gateway_code'],
            where: {
                payment_gateway_code: { [Op.ne]: null }
            }
        },
        {
            name: 'transactions_one_pending_deposit_per_job',
            unique: true,
            fields: ['job_id'],
            where: {
                transaction_type: 'DEPOSIT_10',
                status: 'PENDING'
            }
        },
        {
            name: 'transactions_one_successful_refund_per_deposit',
            unique: true,
            fields: ['reference_transaction_id'],
            where: {
                transaction_type: 'DEPOSIT_REFUND',
                status: 'SUCCESS',
                reference_transaction_id: { [Op.ne]: null }
            }
        },
        // unique index
        {
            name: 'transactions_idempotency_key_unique',
            unique: true,
            fields: ['idempotency_key'],
            where: {
                idempotency_key: { [Op.ne]: null }
            }
        },
        {
            name: 'transactions_cancellation_type',
            fields: ['cancellation_id', 'transaction_type']
        },
        {
            name: 'transactions_completion_request_type',
            fields: ['completion_request_id', 'transaction_type']
        },
        {
            name: 'transactions_warranty_type',
            fields: ['warranty_id', 'transaction_type']
        },
        {
            name: 'transactions_job_created_id',
            fields: ['job_id', 'createdAt', 'id']
        },
        {
            name: 'transactions_type_status_created_id',
            fields: ['transaction_type', 'status', 'createdAt', 'id']
        },
        {
            name: 'transactions_from_wallet_created_id',
            fields: ['from_wallet_id', 'createdAt', 'id']
        },
        {
            name: 'transactions_to_wallet_created_id',
            fields: ['to_wallet_id', 'createdAt', 'id']
        },
        {
            name: 'transactions_payer_created_id',
            fields: ['payer_user_id', 'createdAt', 'id']
        },
        {
            name: 'transactions_one_successful_remaining_payment_per_quote',
            unique: true,
            fields: ['job_id', 'acceptance_cycle', 'quote_id'],
            where: {
                transaction_type: 'SERVICE_REMAINING_PAYMENT',
                status: 'SUCCESS',
                quote_id: { [Op.ne]: null }
            }
        }
    ]
});

export default Transaction;
