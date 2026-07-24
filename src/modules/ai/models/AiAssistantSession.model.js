import { DataTypes, Op } from 'sequelize';
import db from '../../../core/database/connection.js';
import {
  AI_SESSION_STAGES,
  AI_SESSION_STATUSES
} from '../constants/ai.constants.js';

const AiAssistantSession = db.define('AI_Assistant_Session', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  customer_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM(...AI_SESSION_STATUSES),
    allowNull: false,
    defaultValue: 'ACTIVE'
  },
  stage: {
    type: DataTypes.ENUM(...AI_SESSION_STAGES),
    allowNull: false,
    defaultValue: 'COLLECTING_PROBLEM'
  },
  detected_service_id: {
    type: DataTypes.UUID,
    allowNull: true
  },
  problem_summary: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  structured_state: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: {}
  },
  latest_estimate: {
    type: DataTypes.JSONB,
    allowNull: true
  },
  selected_budget: {
    type: DataTypes.JSONB,
    allowNull: true
  },
  recalculation_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    validate: { min: 0 }
  },
  turn_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    validate: { min: 0 }
  },
  revision: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    validate: { min: 0 }
  },
  provider: {
    type: DataTypes.STRING(32),
    allowNull: false,
    defaultValue: 'GEMINI'
  },
  model: {
    type: DataTypes.STRING(160),
    allowNull: true
  },
  prompt_version: {
    type: DataTypes.STRING(80),
    allowNull: false
  },
  estimator_version: {
    type: DataTypes.STRING(80),
    allowNull: false
  },
  expires_at: {
    type: DataTypes.DATE,
    allowNull: false
  },
  applied_job_id: {
    type: DataTypes.UUID,
    allowNull: true
  }
}, {
  indexes: [
    {
      name: 'ai_assistant_sessions_customer_status_updated',
      fields: ['customer_id', 'status', 'updatedAt']
    },
    {
      name: 'ai_assistant_sessions_expiry',
      fields: ['expires_at']
    },
    {
      name: 'ai_assistant_sessions_applied_job_unique',
      unique: true,
      fields: ['applied_job_id'],
      where: { applied_job_id: { [Op.ne]: null } }
    }
  ]
});

export default AiAssistantSession;
