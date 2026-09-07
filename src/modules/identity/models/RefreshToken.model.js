import { DataTypes } from "sequelize";
import db from "../../../core/database/connection.js";

const RefreshToken = db.define(
  "Refresh_Token",
  {
    id: { 
      type: DataTypes.UUID, 
      defaultValue: DataTypes.UUIDV4, 
      primaryKey: true 
    },
    token: { 
      type: DataTypes.TEXT, 
      allowNull: false 
    },
    expires_at: { 
      type: DataTypes.DATE, 
      allowNull: false 
    },
    is_revoked: { 
      type: DataTypes.BOOLEAN, 
      defaultValue: false 
    }
  },
  {
    timestamps: true,
    indexes: [
      { name: 'refresh_tokens_user_revoked', fields: ['user_id', 'is_revoked'] }
    ]
  }
);

export default RefreshToken;
