import { DataTypes } from 'sequelize';
import sequelize from '../../../core/database/connection.js';

const EvidenceVault = sequelize.define('Evidence_Vault', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    stage: { type: DataTypes.ENUM('BEFORE', 'DURING', 'AFTER'), allowNull: false },
    media_url: { type: DataTypes.TEXT, allowNull: false },
    gps_lat: { type: DataTypes.DECIMAL(10, 8) },
    gps_long: { type: DataTypes.DECIMAL(11, 8) },
    file_hash: { type: DataTypes.STRING(256) },
    uploaded_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { timestamps: false });

export default EvidenceVault;