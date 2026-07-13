import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';

const Bid = db.define('Bid', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    proposed_price: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    message: { type: DataTypes.TEXT },
    eta: { type: DataTypes.DATE, allowNull: true },
    estimated_duration_hours: { type: DataTypes.FLOAT, allowNull: true },
    status: {
        type: DataTypes.ENUM(
            'PENDING',
            'WON',
            'LOST',
            'WITHDRAWN',
            'CANCELLED_BY_CUSTOMER',
            'CANCELLED_BY_HANDYMAN',
            'EXPIRED'
        ),
        defaultValue: 'PENDING'
    }
}, { timestamps: true });

export default Bid;
