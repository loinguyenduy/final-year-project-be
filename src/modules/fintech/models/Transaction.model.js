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
        type: DataTypes.ENUM('TOP_UP', 'WITHDRAW', 'DEPOSIT_10', 'LOCK_100', 'PLATFORM_FEE_10', 'WARRANTY_HOLD_20', 'DISBURSE_80', 'WARRANTY_RELEASE', 'REFUND', 'DEPOSIT_REFUND', 'BONDING_DEPOSIT'),
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
        }
    ]
});

export default Transaction;
