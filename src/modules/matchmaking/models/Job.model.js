import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';

const Job = db.define('Job', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    issue_description: { type: DataTypes.TEXT, allowNull: false },
    ai_price_min: { type: DataTypes.DECIMAL(12, 2) },
    ai_price_max: { type: DataTypes.DECIMAL(12, 2) },
    final_agreed_price: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    service_address: { type: DataTypes.TEXT, allowNull: false },
    gps_lat: { type: DataTypes.DECIMAL(10, 8) },
    gps_long: { type: DataTypes.DECIMAL(11, 8) },
    scheduled_at: { type: DataTypes.DATE, allowNull: true },
    images: { type: DataTypes.JSON, defaultValue: [] },
    current_status: { type: DataTypes.ENUM('POSTED', 'BIDDING', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'WARRANTY', 'CLOSED'), defaultValue: 'POSTED' }
}, { timestamps: true });

export default Job;