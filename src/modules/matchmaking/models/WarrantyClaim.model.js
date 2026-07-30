import { DataTypes, Op } from 'sequelize';
import db from '../../../core/database/connection.js';

const WarrantyClaim = db.define('Warranty_Claim', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    job_id: { type: DataTypes.UUID, allowNull: false },
    acceptance_cycle: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1 } },
    warranty_id: { type: DataTypes.UUID, allowNull: false },
    customer_id: { type: DataTypes.UUID, allowNull: false },
    handyman_id: { type: DataTypes.UUID, allowNull: false },
    status: {
        type: DataTypes.ENUM(
            'PENDING_REVIEW',
            'APPROVED_REWORK_REQUIRED',
            'REJECTED',
            'REVIEW_REQUIRED',
            'RESOLVED'
        ),
        allowNull: false,
        defaultValue: 'PENDING_REVIEW'
    },
    reason: {
        type: DataTypes.ENUM(
            'ISSUE_RETURNED',
            'REPAIR_NOT_EFFECTIVE',
            'REPLACED_PART_FAILED',
            'RELATED_DAMAGE_FOUND',
            'WORK_NOT_AS_AGREED',
            'OTHER'
        ),
        allowNull: false
    },
    description: { type: DataTypes.TEXT, allowNull: true },
    submitted_at: { type: DataTypes.DATE, allowNull: false },
    reviewed_at: { type: DataTypes.DATE, allowNull: true },
    reviewed_by_admin_id: { type: DataTypes.UUID, allowNull: true },
    resolved_by_admin_id: { type: DataTypes.UUID, allowNull: true },
    admin_note: { type: DataTypes.TEXT, allowNull: true },
    resolved_at: { type: DataTypes.DATE, allowNull: true }
}, {
    timestamps: true,
    indexes: [
        {
            name: 'warranty_claims_one_active_per_warranty',
            unique: true,
            fields: ['warranty_id'],
            where: {
                status: {
                    [Op.in]: [
                        'PENDING_REVIEW',
                        'APPROVED_REWORK_REQUIRED',
                        'REVIEW_REQUIRED'
                    ]
                }
            }
        },
        { name: 'warranty_claims_job_cycle_status', fields: ['job_id', 'acceptance_cycle', 'status'] },
        { name: 'warranty_claims_review_queue', fields: ['status', 'submitted_at', 'id'] }
    ]
});

export default WarrantyClaim;
