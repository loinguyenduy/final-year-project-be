import { DataTypes, Op } from 'sequelize';
import db from '../../../core/database/connection.js';

const Review = db.define('Review', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    rating_stars: { type: DataTypes.INTEGER, allowNull: false },
    is_job_successful: { type: DataTypes.BOOLEAN, allowNull: false },
    comment: { type: DataTypes.TEXT },
    acceptance_cycle: { type: DataTypes.INTEGER, allowNull: true, validate: { min: 1 } },
    reviewer_role: { type: DataTypes.STRING(20), allowNull: true },
    reviewee_role: { type: DataTypes.STRING(20), allowNull: true }
}, {
    timestamps: true,
    indexes: [
        { name: 'reviews_reviewee_created_id', fields: ['reviewee_id', 'createdAt', 'id'] },
        { name: 'reviews_reviewer_created_id', fields: ['reviewer_id', 'createdAt', 'id'] },
        {
            name: 'reviews_canonical_job_cycle_parties_unique',
            unique: true,
            fields: ['job_id', 'acceptance_cycle', 'reviewer_id', 'reviewee_id'],
            where: {
                acceptance_cycle: { [Op.ne]: null },
                job_id: { [Op.ne]: null },
                reviewer_id: { [Op.ne]: null },
                reviewee_id: { [Op.ne]: null }
            }
        }
    ]
});

export default Review;
