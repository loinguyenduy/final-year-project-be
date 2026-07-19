import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';

const WarrantyCompletionRequestEvidence = db.define('Warranty_Completion_Request_Evidence', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    warranty_completion_request_id: { type: DataTypes.UUID, allowNull: false },
    evidence_id: { type: DataTypes.UUID, allowNull: false },
    snapshotted_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
}, {
    timestamps: false,
    indexes: [
        {
            name: 'warranty_completion_request_evidence_unique',
            unique: true,
            fields: ['warranty_completion_request_id', 'evidence_id']
        },
        {
            name: 'warranty_completion_evidence_one_request_per_evidence',
            unique: true,
            fields: ['evidence_id']
        }
    ]
});

export default WarrantyCompletionRequestEvidence;
