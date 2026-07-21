import { DataTypes } from "sequelize";
import db from "../../../core/database/connection.js";

const User = db.define(
  "User",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    full_name: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },    
      phone_number: { 
      type: DataTypes.STRING(20), 
      unique: true, 
      allowNull: true 
    },
    email: { 
      type: DataTypes.STRING(150), 
      unique: true, 
      allowNull: false 
    },
    role: {
      type: DataTypes.ENUM("ADMIN", "CUSTOMER", "HANDYMAN"),
      allowNull: false,
    },
    is_active: { 
      type: DataTypes.BOOLEAN, 
      defaultValue: true 
    },
    auth_version: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      validate: { min: 0 }
    },
    avatar_url: { 
      type: DataTypes.TEXT, 
      allowNull: true 
    },
    is_email_verified: { 
      type: DataTypes.BOOLEAN, 
      defaultValue: false 
    }, 
    kyc_status: {
      type: DataTypes.ENUM('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED'),
      defaultValue: 'UNVERIFIED'
    }
  },

  {
    timestamps: true,
    indexes: [
      { name: 'users_role_active_created', fields: ['role', 'is_active', 'createdAt', 'id'] },
      { name: 'users_kyc_created', fields: ['kyc_status', 'createdAt', 'id'] }
    ]
  },
);

export default User;
