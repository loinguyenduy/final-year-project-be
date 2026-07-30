import { DataTypes, Op } from 'sequelize';
import db from '../../../core/database/connection.js';

const KycRequest = db.define('KYC_Request', {
    id: { 
        type: DataTypes.UUID, 
        defaultValue: DataTypes.UUIDV4, 
        primaryKey: true 
    },
    user_id: { 
        type: DataTypes.UUID, 
        allowNull: false 
    },
    document_type: { 
        type: DataTypes.ENUM('CCCD_FRONT', 'CCCD_BACK', 'SELFIE', 'CERTIFICATE', 'CV'), 
        allowNull: false
    },
    document_url: { 
        type: DataTypes.TEXT, 
        allowNull: true
    },
    submission_id: {
        type: DataTypes.UUID,
        allowNull: true
    },
    submission_sequence: {
        type: DataTypes.INTEGER,
        allowNull: true,
        validate: { min: 1 }
    },
    cloudinary_public_id: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    cloudinary_format: {
        type: DataTypes.STRING(16),
        allowNull: true
    },
    cloudinary_delivery_type: {
        type: DataTypes.STRING(32),
        allowNull: true
    },
    document_mime_type: {
        type: DataTypes.STRING(64),
        allowNull: true
    },
    status: { 
        type: DataTypes.ENUM('PENDING', 'APPROVED', 'REJECTED'), 
        defaultValue: 'PENDING' 
    },
    admin_notes: { 
        type: DataTypes.TEXT, 
        allowNull: true 
    },
    rejection_reason_code: {
        type: DataTypes.STRING(64),
        allowNull: true
    },
    rejection_reason_text: {
        type: DataTypes.TEXT,
        allowNull: true,
        validate: { len: [0, 500] }
    },
    reviewed_by_admin_id: { 
        type: DataTypes.UUID, 
        allowNull: true 
    },
    reviewed_at: { 
        type: DataTypes.DATE, 
        allowNull: true 
    }
}, {
    timestamps: true,
    indexes: [
        {
            unique: true,
            fields: ['submission_id', 'document_type'],
            where: { submission_id: { [Op.ne]: null } }
        },
        {
            unique: true,
            fields: ['cloudinary_public_id'],
            where: { cloudinary_public_id: { [Op.ne]: null } }
        },
        { fields: ['user_id', 'submission_sequence'] },
        { fields: ['submission_id', 'status'] },
        { fields: ['status', 'createdAt'] }
    ]
});

export default KycRequest;
