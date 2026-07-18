import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';

const JobArrivalRequest = db.define('Job_Arrival_Request', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    job_id: { type: DataTypes.UUID, allowNull: false },
    acceptance_cycle: {
        type: DataTypes.INTEGER,
        allowNull: false,
        validate: { min: 1 }
    },
    customer_id: { type: DataTypes.UUID, allowNull: false },
    handyman_id: { type: DataTypes.UUID, allowNull: false },
    status: {
        type: DataTypes.ENUM('PENDING', 'CONFIRMED', 'REJECTED', 'SUPERSEDED'),
        allowNull: false,
        defaultValue: 'PENDING'
    },
    request_gps_lat: { type: DataTypes.DECIMAL(10, 8), allowNull: true },
    request_gps_long: { type: DataTypes.DECIMAL(11, 8), allowNull: true },
    request_gps_accuracy_meters: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
        validate: { min: 0 }
    },
    distance_to_job_meters: {
        type: DataTypes.INTEGER,
        allowNull: true,
        validate: { min: 0 }
    },
    location_warning: {
        type: DataTypes.ENUM('NEAR_JOB', 'FAR_FROM_JOB', 'LOCATION_UNAVAILABLE'),
        allowNull: false
    },
    requested_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
    },
    responded_at: { type: DataTypes.DATE, allowNull: true },
    responded_by_user_id: { type: DataTypes.UUID, allowNull: true },
    rejection_reason: {
        type: DataTypes.ENUM(
            'HANDYMAN_NOT_PRESENT',
            'WRONG_LOCATION',
            'ARRIVAL_REQUEST_SENT_TOO_EARLY',
            'OTHER'
        ),
        allowNull: true
    },
    rejection_reason_text: { type: DataTypes.TEXT, allowNull: true }
}, {
    timestamps: true,
    indexes: [
        {
            name: 'job_arrival_requests_one_pending_per_cycle',
            unique: true,
            fields: ['job_id', 'acceptance_cycle'],
            where: { status: 'PENDING' }
        },
        {
            name: 'job_arrival_requests_job_cycle_status',
            fields: ['job_id', 'acceptance_cycle', 'status']
        },
        {
            name: 'job_arrival_requests_handyman_status',
            fields: ['handyman_id', 'status']
        },
        {
            name: 'job_arrival_requests_customer_status',
            fields: ['customer_id', 'status']
        }
    ]
});

export default JobArrivalRequest;
