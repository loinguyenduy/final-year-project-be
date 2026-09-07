import { DataTypes } from "sequelize";
import db from "../../../core/database/connection.js";

const VerificationToken = db.define(
  "Verification_Token",
  {
    id: { 
      type: DataTypes.UUID, 
      defaultValue: DataTypes.UUIDV4, 
      primaryKey: true 
    },
    token: { 
      type: DataTypes.STRING(255), 
      allowNull: false 
    },
    expires_at: { 
      type: DataTypes.DATE, 
      allowNull: false 
    },
  },
  { 
    timestamps: true 
  }
);

export default VerificationToken;