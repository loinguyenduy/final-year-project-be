import { DataTypes } from 'sequelize';
import sequelize from '../../../core/database/connection.js';

const Service = sequelize.define('Service', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    service_code: { type: DataTypes.STRING(50), unique: true, allowNull: false },
    name: { type: DataTypes.STRING(100), allowNull: false },
    icon_url: { type: DataTypes.TEXT },
    is_active: { type: DataTypes.BOOLEAN, defaultValue: true }
}, { timestamps: false });

export default Service;