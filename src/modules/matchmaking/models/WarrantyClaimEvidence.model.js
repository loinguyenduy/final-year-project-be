import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';

const WarrantyClaimEvidence = db.define('Warranty_Claim_Evidence', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    claim_id: { type: DataTypes.UUID, allowNull: false },
    evidence_id: { type: DataTypes.UUID, allowNull: false },
    snapshotted_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
}, {
    timestamps: false,
    indexes: [
        {
            name: 'warranty_claim_evidence_unique',
            unique: true,
            fields: ['claim_id', 'evidence_id']
        },
        {
            name: 'warranty_claim_evidence_one_claim_per_evidence',
            unique: true,
            fields: ['evidence_id']
        }
    ]
});

export default WarrantyClaimEvidence;
