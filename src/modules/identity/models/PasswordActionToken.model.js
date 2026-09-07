import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';

const PasswordActionToken = db.define('Password_Action_Token', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  purpose: {
    type: DataTypes.ENUM('RESET_PASSWORD', 'SET_PASSWORD'),
    allowNull: false
  },
  token_hash: {
    type: DataTypes.STRING(64),
    allowNull: false
  },
  issued_auth_version: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  expires_at: {
    type: DataTypes.DATE,
    allowNull: false
  },
  consumed_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  revoked_at: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  updatedAt: false,
  indexes: [
    { name: 'password_action_tokens_user_purpose_expiry', fields: ['user_id', 'purpose', 'expires_at'] },
    { name: 'password_action_tokens_hash_unique', unique: true, fields: ['token_hash'] }
  ]
});

export default PasswordActionToken;
