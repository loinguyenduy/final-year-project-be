import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';

const EvidenceVault = db.define('Evidence_Vault', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    job_id: { type: DataTypes.UUID, allowNull: true },
    acceptance_cycle: {
        type: DataTypes.INTEGER,
        allowNull: true,
        validate: { min: 1 }
    },
    customer_id: { type: DataTypes.UUID, allowNull: true },
    handyman_id: { type: DataTypes.UUID, allowNull: true },
    selected_bid_id: { type: DataTypes.UUID, allowNull: true },
    uploader_id: { type: DataTypes.UUID, allowNull: true },
    stage: {
        type: DataTypes.ENUM('BEFORE', 'DURING', 'AFTER', 'WARRANTY_CLAIM', 'WARRANTY'),
        allowNull: false
    },
    media_type: {
        type: DataTypes.ENUM('IMAGE'),
        allowNull: true
    },
    media_url: { type: DataTypes.TEXT, allowNull: false },
    cloudinary_public_id: { type: DataTypes.TEXT, allowNull: true },
    mime_type: { type: DataTypes.STRING(100), allowNull: true },
    file_size: {
        type: DataTypes.INTEGER,
        allowNull: true,
        validate: { min: 0 }
    },
    gps_lat: { type: DataTypes.DECIMAL(10, 8) },
    gps_long: { type: DataTypes.DECIMAL(11, 8) },
    file_hash: { type: DataTypes.STRING(256) },
    uploaded_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
    timestamps: false,
    indexes: [
        {
            name: 'evidence_vaults_job_cycle_stage',
            fields: ['job_id', 'acceptance_cycle', 'stage']
        },
        {
            name: 'evidence_vaults_job_cycle_stage_uploader',
            fields: ['job_id', 'acceptance_cycle', 'stage', 'uploader_id']
        },
        {
            name: 'evidence_vaults_job_cycle_uploaded_id',
            fields: ['job_id', 'acceptance_cycle', 'uploaded_at', 'id']
        }
    ]
});

export default EvidenceVault;
