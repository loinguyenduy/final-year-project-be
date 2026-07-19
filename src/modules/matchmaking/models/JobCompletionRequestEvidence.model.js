import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';

const JobCompletionRequestEvidence = db.define('Job_Completion_Request_Evidence', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    completion_request_id: { type: DataTypes.UUID, allowNull: false },
    evidence_id: { type: DataTypes.UUID, allowNull: false },
    snapshotted_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
}, {
    timestamps: false,
    indexes: [
        {
            name: 'completion_request_evidence_unique',
            unique: true,
            fields: ['completion_request_id', 'evidence_id']
        },
        { name: 'completion_request_evidence_evidence_idx', fields: ['evidence_id'] }
    ]
});

export default JobCompletionRequestEvidence;
