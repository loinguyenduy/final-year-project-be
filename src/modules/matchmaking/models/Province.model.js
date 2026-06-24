import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';

const Province = db.define('Province', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true
    },
    province_code: {
        type: DataTypes.STRING(2),
        allowNull: false,
        unique: true
    },
    name: {
        type: DataTypes.STRING(255),
        allowNull: false
    },
    short_name: {
        type: DataTypes.STRING(255),
        allowNull: false
    },
    code: {
        type: DataTypes.STRING(5),
        allowNull: false,
        unique: true
    },
    place_type: {
        type: DataTypes.STRING(255),
        allowNull: false
    },
    country: {
        type: DataTypes.STRING(10),
        allowNull: false
    }
}, {
    timestamps: false      
});

export default Province;