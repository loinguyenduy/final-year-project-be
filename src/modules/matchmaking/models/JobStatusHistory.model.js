import { DataTypes } from 'sequelize';
import sequelize from '../../../core/database/connection.js';

const JobStatusHistory = sequelize.define('Job_Status_History', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    old_status: { type: DataTypes.STRING(50), allowNull: true },
    new_status: { type: DataTypes.STRING(50), allowNull: false },
    trigger_gps_lat: { type: DataTypes.DECIMAL(10, 8), allowNull: true },
    trigger_gps_long: { type: DataTypes.DECIMAL(11, 8), allowNull: true }
}, { timestamps: true });

export default JobStatusHistory;