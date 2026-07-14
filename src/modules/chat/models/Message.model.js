import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';

const Message = db.define('Message', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  conversation_id: { type: DataTypes.UUID, allowNull: false },
  sender_id: { type: DataTypes.UUID, allowNull: false },
  client_message_id: { type: DataTypes.UUID, allowNull: false },
  message_type: {
    type: DataTypes.ENUM('TEXT'),
    allowNull: false,
    defaultValue: 'TEXT'
  },
  content: { type: DataTypes.TEXT, allowNull: false }
}, {
  timestamps: true,
  indexes: [
    {
      name: 'messages_idempotency_unique',
      unique: true,
      fields: ['conversation_id', 'sender_id', 'client_message_id']
    },
    {
      name: 'messages_conversation_page_idx',
      fields: ['conversation_id', 'createdAt', 'id']
    }
  ]
});

export default Message;
