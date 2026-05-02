import { DataTypes } from 'sequelize';
import sequelize from '../../../core/database/connection.js';

const AuthProvider = sequelize.define('Auth_Provider', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    provider: { type: DataTypes.ENUM('LOCAL', 'GOOGLE', 'FACEBOOK', 'FIREBASE'), allowNull: false },
    provider_id: { type: DataTypes.STRING(255), allowNull: true },
    password_hash: { type: DataTypes.STRING(255), allowNull: true }
}, { timestamps: true });

export default AuthProvider;