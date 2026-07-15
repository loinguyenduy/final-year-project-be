import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';

const JobQuoteItem = db.define('Job_Quote_Item', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    quote_id: { type: DataTypes.UUID, allowNull: false },
    item_type: {
        type: DataTypes.ENUM('LABOUR', 'MATERIAL', 'OTHER'),
        allowNull: false
    },
    description: { type: DataTypes.TEXT, allowNull: false },
    quantity: { type: DataTypes.DECIMAL(12, 3), allowNull: false },
    unit: { type: DataTypes.STRING(50), allowNull: false },
    unit_price: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    line_total: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    sort_order: {
        type: DataTypes.INTEGER,
        allowNull: false,
        validate: { min: 0 }
    }
}, {
    timestamps: true,
    indexes: [
        { name: 'job_quote_items_quote_idx', fields: ['quote_id'] },
        {
            name: 'job_quote_items_quote_sort_unique',
            unique: true,
            fields: ['quote_id', 'sort_order']
        }
    ]
});

export default JobQuoteItem;
