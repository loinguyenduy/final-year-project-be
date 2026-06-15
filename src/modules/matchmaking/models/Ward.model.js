import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';

const Ward = db.define('Ward', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true
    },
    ward_code: {
        type: DataTypes.STRING(6),
        allowNull: false,
        unique: true
    },
    name: {
        type: DataTypes.STRING(255),
        allowNull: false
    },
    province_code: {
        type: DataTypes.STRING(2),
        allowNull: false
    }
}, {
    timestamps: false
});

export default Ward;