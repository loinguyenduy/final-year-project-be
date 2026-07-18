import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';

const HandymanService = db.define('Handyman_Service', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    handyman_id: { type: DataTypes.UUID, allowNull: false },
    service_id: { type: DataTypes.UUID, allowNull: false },
}, {
    timestamps: true,
    indexes: [{ unique: true, fields: ['handyman_id', 'service_id'] }]
});

export default HandymanService;
