import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';

const JobQuote = db.define('Job_Quote', {
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
    selected_bid_id: { type: DataTypes.UUID, allowNull: false },
    version: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        validate: { min: 1 }
    },
    draft_revision: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        validate: { min: 0 }
    },
    status: {
        type: DataTypes.ENUM('DRAFT', 'SUBMITTED', 'SUPERSEDED', 'ACCEPTED', 'REJECTED'),
        allowNull: false,
        defaultValue: 'DRAFT'
    },
    problem_summary: { type: DataTypes.TEXT, allowNull: true },
    inspection_notes: { type: DataTypes.TEXT, allowNull: true },
    recommended_solution: { type: DataTypes.TEXT, allowNull: true },
    estimated_duration_minutes: {
        type: DataTypes.INTEGER,
        allowNull: true,
        validate: { min: 1 }
    },
    warranty_days: {
        type: DataTypes.INTEGER,
        allowNull: true,
        validate: { min: 0 }
    },
    subtotal_amount: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: false,
        defaultValue: 0
    },
    discount_amount: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: false,
        defaultValue: 0
    },
    total_amount: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: false,
        defaultValue: 0
    },
    currency: {
        type: DataTypes.STRING(3),
        allowNull: false,
        defaultValue: 'VND'
    },
    bid_reference_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    variance_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
    variance_percent: { type: DataTypes.DECIMAL(20, 4), allowNull: true },
    variance_reason: {
        type: DataTypes.ENUM(
            'ADDITIONAL_DAMAGE_FOUND',
            'CUSTOMER_ADDED_SCOPE',
            'PARTS_OR_MATERIAL_CHANGED',
            'INITIAL_DESCRIPTION_INCOMPLETE',
            'ACCESS_CONDITION_DIFFERENT',
            'OTHER'
        ),
        allowNull: true
    },
    variance_reason_text: { type: DataTypes.TEXT, allowNull: true },
    submitted_at: { type: DataTypes.DATE, allowNull: true },
    customer_responded_at: { type: DataTypes.DATE, allowNull: true },
    customer_response_by_user_id: { type: DataTypes.UUID, allowNull: true },
    accepted_at: { type: DataTypes.DATE, allowNull: true },
    rejected_at: { type: DataTypes.DATE, allowNull: true },
    rejection_reason: {
        type: DataTypes.ENUM('FINAL_QUOTE_TOO_HIGH', 'FINAL_QUOTE_NOT_ACCEPTABLE'),
        allowNull: true
    },
    rejection_reason_text: { type: DataTypes.TEXT, allowNull: true }
}, {
    timestamps: true,
    indexes: [
        {
            name: 'job_quotes_job_cycle_version_unique',
            unique: true,
            fields: ['job_id', 'acceptance_cycle', 'version']
        },
        {
            name: 'job_quotes_one_draft_per_cycle',
            unique: true,
            fields: ['job_id', 'acceptance_cycle'],
            where: { status: 'DRAFT' }
        },
        {
            name: 'job_quotes_job_cycle_status',
            fields: ['job_id', 'acceptance_cycle', 'status']
        },
        { name: 'job_quotes_customer_status', fields: ['customer_id', 'status'] },
        { name: 'job_quotes_handyman_status', fields: ['handyman_id', 'status'] }
    ]
});

export default JobQuote;
