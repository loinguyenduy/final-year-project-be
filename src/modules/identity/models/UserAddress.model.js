import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';

const UserAddress = db.define('User_Address', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    province_code: { type: DataTypes.STRING(2), allowNull: false },
    ward_code: { type: DataTypes.STRING(6), allowNull: false },
    detail_address: { type: DataTypes.TEXT, allowNull: false }, 
    full_address: { type: DataTypes.TEXT, allowNull: false },   
    gps_lat: { type: DataTypes.DECIMAL(10, 8), allowNull: true },
    gps_long: { type: DataTypes.DECIMAL(11, 8), allowNull: true },
    is_default: { type: DataTypes.BOOLEAN, defaultValue: false }
}, { timestamps: true });

export default UserAddress;