import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';

const HandymanServiceArea = db.define('Handyman_Service_Area', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    handyman_id: { type: DataTypes.UUID, allowNull: false },
    province_code: { type: DataTypes.STRING(2), allowNull: false },
    // null = phục vụ cả tỉnh; set = chỉ phường/xã đó
    ward_code: { type: DataTypes.STRING(6), allowNull: true },
}, {
    timestamps: true,
    indexes: [{ unique: true, fields: ['handyman_id', 'province_code', 'ward_code'] }]
});

export default HandymanServiceArea;
