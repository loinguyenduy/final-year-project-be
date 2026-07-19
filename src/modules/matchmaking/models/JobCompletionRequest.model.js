import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';

const JobCompletionRequest = db.define('Job_Completion_Request', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    job_id: { type: DataTypes.UUID, allowNull: false },
    acceptance_cycle: {
        type: DataTypes.INTEGER,
        allowNull: false,
        validate: { min: 1 }
    },
    customer_id: { type: DataTypes.UUID, allowNull: false },
    handyman_id: { type: DataTypes.UUID, allowNull: false },
    status: {
        type: DataTypes.ENUM('PENDING', 'CONFIRMED', 'REJECTED'),
        allowNull: false,
        defaultValue: 'PENDING'
    },
    request_sequence: {
        type: DataTypes.INTEGER,
        allowNull: false,
        validate: { min: 1 }
    },
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
            name: 'completion_requests_job_cycle_sequence_unique',
            unique: true,
            fields: ['job_id', 'acceptance_cycle', 'request_sequence']
        },
        {
            name: 'completion_requests_one_pending_per_cycle',
            unique: true,
            fields: ['job_id', 'acceptance_cycle'],
            where: { status: 'PENDING' }
        },
        {
            name: 'completion_requests_job_cycle_status',
            fields: ['job_id', 'acceptance_cycle', 'status']
        }
    ]
});

export default JobCompletionRequest;
