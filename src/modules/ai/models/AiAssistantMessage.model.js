import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';
import { AI_MESSAGE_SENDERS } from '../constants/ai.constants.js';

const AiAssistantMessage = db.define('AI_Assistant_Message', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  session_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  sender: {
    type: DataTypes.ENUM(...AI_MESSAGE_SENDERS),
    allowNull: false
  },
  message_text: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  sequence: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: { min: 1 }
  },
  client_message_id: {
    type: DataTypes.UUID,
    allowNull: true
  },
  provider_metadata: {
    type: DataTypes.JSONB,
    allowNull: true
  }
}, {
  timestamps: true,
  updatedAt: false,
  indexes: [
    {
      name: 'ai_assistant_messages_session_sequence_unique',
      unique: true,
      fields: ['session_id', 'sequence']
    },
    {
      name: 'ai_assistant_messages_session_client_unique',
      unique: true,
      fields: ['session_id', 'client_message_id']
    }
  ]
});

export default AiAssistantMessage;
