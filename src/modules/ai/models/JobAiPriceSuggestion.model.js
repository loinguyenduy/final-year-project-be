import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';
import {
  AI_COMPLEXITIES,
  AI_PRICE_CONFIDENCES
} from '../constants/ai.constants.js';

const immutableError = () => {
  throw new Error('Job AI Price Suggestion records are immutable at the application layer.');
};

const JobAiPriceSuggestion = db.define('Job_AI_Price_Suggestion', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  job_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  assistant_session_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  service_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  problem_summary: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  complexity: {
    type: DataTypes.ENUM(...AI_COMPLEXITIES),
    allowNull: false,
    defaultValue: 'UNKNOWN'
  },
  suggested_min_amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: true
  },
  suggested_typical_amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: true
  },
  suggested_max_amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: true
  },
  confidence: {
    type: DataTypes.ENUM(...AI_PRICE_CONFIDENCES),
    allowNull: false
  },
  sample_count: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  candidate_count: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  customer_decision: {
    type: DataTypes.ENUM(
      'ACCEPTED_SUGGESTION',
      'USED_OWN_BUDGET',
      'CONTINUED_WITHOUT_ESTIMATE'
    ),
    allowNull: false
  },
  customer_budget_min: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: true
  },
  customer_budget_max: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: true
  },
  prompt_version: {
    type: DataTypes.STRING(80),
    allowNull: false
  },
  estimator_version: {
    type: DataTypes.STRING(80),
    allowNull: false
  }
}, {
  timestamps: true,
  updatedAt: false,
  indexes: [
    {
      name: 'job_ai_price_suggestions_job_unique',
      unique: true,
      fields: ['job_id']
    },
    {
      name: 'job_ai_price_suggestions_session_unique',
      unique: true,
      fields: ['assistant_session_id']
    }
  ],
  hooks: {
    beforeUpdate: immutableError,
    beforeDestroy: immutableError,
    beforeBulkUpdate: immutableError,
    beforeBulkDestroy: immutableError
  }
});

export default JobAiPriceSuggestion;
