import { DataTypes, Op } from 'sequelize';
import db from '../../../core/database/connection.js';

const Wallet = db.define('Wallet', {
    id: { 
        type: DataTypes.UUID, 
        defaultValue: DataTypes.UUIDV4, 
        primaryKey: true 
    },
    wallet_type: { 
        type: DataTypes.ENUM('CUSTOMER_MAIN', 'HANDYMAN_MAIN', 'HANDYMAN_ESCROW', 'SYSTEM_PROFIT', 'SYSTEM_ESCROW'), 
        allowNull: false 
    },
    balance: { 
        type: DataTypes.DECIMAL(15, 2), 
        defaultValue: 0.00 
    },
    currency: { 
        type: DataTypes.STRING(3), 
        defaultValue: 'VND' 
    },
    is_blocked: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    }
}, {
    timestamps: true,
    indexes: [
        {
            name: 'wallets_user_type_unique',
            unique: true,
            fields: ['user_id', 'wallet_type']
        },
        {
            name: 'wallets_global_system_type_unique',
            unique: true,
            fields: ['wallet_type'],
            where: {
                wallet_type: {
                    [Op.in]: ['SYSTEM_PROFIT', 'SYSTEM_ESCROW']
                }
            }
        }
    ]
});

export default Wallet;
