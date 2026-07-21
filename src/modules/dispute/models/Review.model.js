import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';

const Review = db.define('Review', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    rating_stars: { type: DataTypes.INTEGER, allowNull: false },
    is_job_successful: { type: DataTypes.BOOLEAN, allowNull: false },
    comment: { type: DataTypes.TEXT }
}, {
    timestamps: true,
    indexes: [
        { name: 'reviews_reviewee_created_id', fields: ['reviewee_id', 'createdAt', 'id'] }
    ]
});

export default Review;
