import { DataTypes } from 'sequelize';
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
        type: DataTypes.ENUM('TOP_UP', 'WITHDRAW', 'DEPOSIT_10', 'LOCK_100', 'PLATFORM_FEE_10', 'WARRANTY_HOLD_20', 'DISBURSE_80', 'WARRANTY_RELEASE', 'REFUND', 'BONDING_DEPOSIT'), 
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
        comment: 'Store the orderCode from PayOS or VNPay transaction ID'
    },
    description: {
        type: DataTypes.STRING(255),
        allowNull: true
    }
}, { timestamps: true });

export default Transaction;