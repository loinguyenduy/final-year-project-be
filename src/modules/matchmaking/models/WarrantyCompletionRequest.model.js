import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';

const WarrantyCompletionRequest = db.define('Warranty_Completion_Request', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    job_id: { type: DataTypes.UUID, allowNull: false },
    acceptance_cycle: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1 } },
    warranty_id: { type: DataTypes.UUID, allowNull: false },
    claim_id: { type: DataTypes.UUID, allowNull: false },
    customer_id: { type: DataTypes.UUID, allowNull: false },
    handyman_id: { type: DataTypes.UUID, allowNull: false },
    status: {
        type: DataTypes.ENUM('PENDING', 'CONFIRMED', 'REJECTED'),
        allowNull: false,
        defaultValue: 'PENDING'
    },
    request_sequence: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1 } },
    completion_note: { type: DataTypes.TEXT, allowNull: true },
    requested_at: { type: DataTypes.DATE, allowNull: false },
    responded_at: { type: DataTypes.DATE, allowNull: true },
    responded_by_user_id: { type: DataTypes.UUID, allowNull: true },
    rejection_reason: {
        type: DataTypes.ENUM(
            'WORK_NOT_COMPLETED',
            'RESULT_NOT_AS_AGREED',
            'FUNCTION_NOT_WORKING',
            'ADDITIONAL_DAMAGE_FOUND',
            'CLEANUP_NOT_COMPLETED',
            'OTHER'
        ),
        allowNull: true
    },
    rejection_note: { type: DataTypes.TEXT, allowNull: true }
}, {
    timestamps: true,
    indexes: [
        {
            name: 'warranty_completion_requests_sequence_unique',
            unique: true,
            fields: ['warranty_id', 'request_sequence']
        },
        {
            name: 'warranty_completion_requests_one_pending',
            unique: true,
            fields: ['warranty_id'],
            where: { status: 'PENDING' }
        },
        { name: 'warranty_completion_requests_job_status', fields: ['job_id', 'status'] },
        { name: 'warranty_completion_requests_review_queue', fields: ['status', 'responded_at', 'id'] }
    ]
});

export default WarrantyCompletionRequest;
