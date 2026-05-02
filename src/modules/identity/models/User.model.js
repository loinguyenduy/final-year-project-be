import { DataTypes } from "sequelize";
import sequelize from "../../../core/database/connection.js";

const User = sequelize.define(
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
    phone_number: { type: DataTypes.STRING(20), unique: true, allowNull: true },
    email: { type: DataTypes.STRING(150), unique: true, allowNull: false },
    role: {
      type: DataTypes.ENUM("ADMIN", "CUSTOMER", "HANDYMAN"),
      allowNull: false,
    },
    is_active: { type: DataTypes.BOOLEAN, defaultValue: true },
    avatar_url: { type: DataTypes.STRING(255), allowNull: true },
  },
  { timestamps: true },
);

export default User;
