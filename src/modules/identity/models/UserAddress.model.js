import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';

const UserAddress = db.define('User_Address', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    address_line: { type: DataTypes.TEXT, allowNull: false },
    gps_lat: { type: DataTypes.DECIMAL(10, 8) },
    gps_long: { type: DataTypes.DECIMAL(11, 8) },
    is_default: { type: DataTypes.BOOLEAN, defaultValue: false }
}, { timestamps: true });

export default UserAddress;