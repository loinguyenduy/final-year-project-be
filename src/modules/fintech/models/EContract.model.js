import { DataTypes } from 'sequelize';
import sequelize from '../../../core/database/connection.js';

const EContract = sequelize.define('E_Contract', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    pdf_url: { type: DataTypes.TEXT, allowNull: false },
    customer_otp_signature: { type: DataTypes.STRING(10) },
    agreed_price: { type: DataTypes.DECIMAL(12, 2) },
    generated_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { timestamps: false });

export default EContract;