import { DataTypes } from 'sequelize';
import sequelize from '../../../core/database/connection.js';

const KycRequest = sequelize.define('KYC_Request', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    document_type: { type: DataTypes.ENUM('CCCD_FRONT', 'CCCD_BACK', 'SELFIE', 'CERTIFICATE', 'CV'), allowNull: false },
    document_url: { type: DataTypes.TEXT, allowNull: false },
    status: { type: DataTypes.ENUM('PENDING', 'APPROVED', 'REJECTED'), defaultValue: 'PENDING' },
    admin_notes: { type: DataTypes.TEXT, allowNull: true }
}, { timestamps: true });

export default KycRequest;