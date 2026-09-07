import { DataTypes, Op } from 'sequelize';
import db from '../../../core/database/connection.js';

const immutableError = () => {
  throw new Error('Admin Audit Log records are immutable.');
};

const AdminAuditLog = db.define('Admin_Audit_Log', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  admin_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  action: {
    type: DataTypes.STRING(80),
    allowNull: false
  },
  target_type: {
    type: DataTypes.STRING(50),
    allowNull: false
  },
  target_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  reason_code: {
    type: DataTypes.STRING(64),
    allowNull: true
  },
  reason_text: {
    type: DataTypes.TEXT,
    allowNull: true,
    validate: { len: [0, 500] }
  },
  before_state: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: {}
  },
  after_state: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: {}
  },
  correlation_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  ip_address: {
    type: DataTypes.STRING(64),
    allowNull: true
  },
  user_agent: {
    type: DataTypes.STRING(512),
    allowNull: true
  },
  idempotency_key: {
    type: DataTypes.UUID,
    allowNull: true
  },
  request_fingerprint: {
    type: DataTypes.CHAR(64),
    allowNull: true
  }
}, {
  timestamps: true,
  updatedAt: false,
  indexes: [
    { fields: ['admin_id', 'createdAt'] },
    { fields: ['target_type', 'target_id', 'createdAt'] },
    { fields: ['action', 'createdAt'] },
    { fields: ['correlation_id'] },
    {
      name: 'admin_audit_scoped_idempotency_unique',
      unique: true,
      fields: ['action', 'target_type', 'target_id', 'idempotency_key'],
      where: { idempotency_key: { [Op.ne]: null } }
    }
  ],
  hooks: {
    beforeUpdate: immutableError,
    beforeDestroy: immutableError,
    beforeBulkUpdate: immutableError,
    beforeBulkDestroy: immutableError
  }
});

export default AdminAuditLog;
