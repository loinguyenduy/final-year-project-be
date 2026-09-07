import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';

const JobStatusHistory = db.define('Job_Status_History', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    old_status: { type: DataTypes.STRING(50), allowNull: true },
    new_status: { type: DataTypes.STRING(50), allowNull: false },
    reason: { type: DataTypes.TEXT, allowNull: true },
    trigger_gps_lat: { type: DataTypes.DECIMAL(10, 8), allowNull: true },
    trigger_gps_long: { type: DataTypes.DECIMAL(11, 8), allowNull: true }
}, {
    timestamps: true,
    indexes: [
        { name: 'job_status_history_job_created_id', fields: ['job_id', 'createdAt', 'id'] }
    ]
});

export default JobStatusHistory;
