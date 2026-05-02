import { DataTypes } from 'sequelize';
import sequelize from '../../../core/database/connection.js';

const Bid = sequelize.define('Bid', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    proposed_price: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    message: { type: DataTypes.TEXT },
    status: { type: DataTypes.ENUM('PENDING', 'WON', 'LOST'), defaultValue: 'PENDING' }
}, { timestamps: true });

export default Bid;