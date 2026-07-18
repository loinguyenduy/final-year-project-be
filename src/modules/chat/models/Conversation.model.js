import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';
import {
  CONVERSATION_CLOSED_REASONS,
  CONVERSATION_STATUSES
} from '../constants/chat.constants.js';

const Conversation = db.define('Conversation', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  job_id: { type: DataTypes.UUID, allowNull: false },
  acceptance_cycle: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: { min: 1 }
  },
  customer_id: { type: DataTypes.UUID, allowNull: false },
  handyman_id: { type: DataTypes.UUID, allowNull: false },
  selected_bid_id: { type: DataTypes.UUID, allowNull: false },
  status: {
    type: DataTypes.ENUM(...Object.values(CONVERSATION_STATUSES)),
    allowNull: false,
    defaultValue: CONVERSATION_STATUSES.ACTIVE
  },
  closed_at: { type: DataTypes.DATE, allowNull: true },
  closed_reason: {
    type: DataTypes.STRING(64),
    allowNull: true,
    validate: { isIn: [Object.values(CONVERSATION_CLOSED_REASONS)] }
  },
  closed_by_user_id: { type: DataTypes.UUID, allowNull: true },
  last_message_at: { type: DataTypes.DATE, allowNull: true },
  customer_last_read_message_id: { type: DataTypes.UUID, allowNull: true },
  customer_last_read_at: { type: DataTypes.DATE, allowNull: true },
  handyman_last_read_message_id: { type: DataTypes.UUID, allowNull: true },
  handyman_last_read_at: { type: DataTypes.DATE, allowNull: true }
}, {
  timestamps: true,
  indexes: [
    {
      name: 'conversations_job_acceptance_cycle_unique',
      unique: true,
      fields: ['job_id', 'acceptance_cycle']
    },
    {
      name: 'conversations_one_active_per_job',
      unique: true,
      fields: ['job_id'],
      where: { status: CONVERSATION_STATUSES.ACTIVE }
    },
    { name: 'conversations_customer_idx', fields: ['customer_id'] },
    { name: 'conversations_handyman_idx', fields: ['handyman_id'] },
    { name: 'conversations_status_idx', fields: ['status'] },
    { name: 'conversations_last_message_idx', fields: ['last_message_at'] }
  ]
});

export default Conversation;
