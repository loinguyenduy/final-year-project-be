import crypto from 'crypto';
import { fn, col, Op } from 'sequelize';
import db from '../../../core/database/connection.js';
import { createSignedCloudinaryImageUrl } from '../../../core/utils/cloudinary.util.js';
import { emitToRole, emitToUsers } from '../../../core/realtime/realtime.gateway.js';
import User from '../../identity/models/User.model.js';
import KycRequest from '../../identity/models/KycRequest.model.js';
import HandymanProfile from '../../identity/models/HandymanProfile.model.js';
import {
  KYC_REALTIME_EVENTS,
  KYC_REJECTION_REASONS,
  KYC_REQUIRED_DOCUMENTS
} from '../../identity/constants/kyc.constants.js';
import { createAdminAuditLog } from './AdminAudit.service.js';
import {
  ADMIN_AUDIT_ACTIONS,
  ADMIN_AUDIT_TARGETS,
  ADMIN_KYC_ACTIONS
} from '../constants/admin.constants.js';

class AdminKycError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'AdminKycError';
    this.status = status;
    this.code = code;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const assertUuid = (value, field) => {
  if (!UUID_PATTERN.test(String(value || ''))) {
    throw new AdminKycError(`${field} must be a valid UUID.`, 400, 'VALIDATION_ERROR');
  }
};

const parsePositiveInteger = (value, field, fallback, maximum = Number.MAX_SAFE_INTEGER) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) {
    throw new AdminKycError(`${field} must be a positive integer.`, 400, 'VALIDATION_ERROR');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new AdminKycError(`${field} is outside the allowed range.`, 400, 'VALIDATION_ERROR');
  }
  return parsed;
};

const parseListQuery = (query = {}) => {
  const page = parsePositiveInteger(query.page, 'page', 1);
  const pageSize = parsePositiveInteger(query.page_size, 'page_size', 20, 100);
  const status = String(query.status || 'PENDING').trim().toUpperCase();
  const role = String(query.role || 'ALL').trim().toUpperCase();
  const search = String(query.search || '').trim();
  if (!['PENDING', 'APPROVED', 'REJECTED', 'ALL'].includes(status)) {
    throw new AdminKycError('Invalid KYC status filter.', 400, 'VALIDATION_ERROR');
  }
  if (!['CUSTOMER', 'HANDYMAN', 'ALL'].includes(role)) {
    throw new AdminKycError('Invalid user role filter.', 400, 'VALIDATION_ERROR');
  }
  if (search.length > 100) {
    throw new AdminKycError('Search text must be 100 characters or fewer.', 400, 'VALIDATION_ERROR');
  }
  return { page, pageSize, status, role, search };
};

const getRequiredCount = (role) => KYC_REQUIRED_DOCUMENTS[role]?.length || 0;

const toListItem = (row) => {
  const item = row.get({ plain: true });
  const documentCount = Number(item.document_count) || 0;
  const requiredCount = getRequiredCount(item.Owner?.role);
  return {
    id: item.submission_id,
    submission_sequence: item.submission_sequence,
    status: item.status,
    submitted_at: item.submitted_at,
    reviewed_at: item.reviewed_at || null,
    document_count: documentCount,
    required_document_count: requiredCount,
    is_complete: requiredCount > 0 && documentCount === requiredCount,
    user: item.Owner
  };
};

const getKycRequestsService = async (query = {}) => {
  const { page, pageSize, status, role, search } = parseListQuery(query);
  const where = { submission_id: { [Op.ne]: null } };
  if (status !== 'ALL') where.status = status;
  const ownerWhere = {};
  if (role !== 'ALL') ownerWhere.role = role;
  if (search) {
    ownerWhere[Op.or] = [
      { full_name: { [Op.iLike]: `%${search}%` } },
      { email: { [Op.iLike]: `%${search}%` } }
    ];
  }

  const result = await KycRequest.findAndCountAll({
    attributes: [
      'submission_id',
      'submission_sequence',
      'status',
      [fn('MIN', col('KYC_Request.createdAt')), 'submitted_at'],
      [fn('MAX', col('reviewed_at')), 'reviewed_at'],
      [fn('COUNT', col('KYC_Request.id')), 'document_count']
    ],
    where,
    include: [{
      model: User,
      as: 'Owner',
      required: true,
      where: ownerWhere,
      attributes: ['id', 'full_name', 'email', 'role', 'avatar_url']
    }],
    group: [
      'KYC_Request.submission_id',
      'KYC_Request.submission_sequence',
      'KYC_Request.status',
      'Owner.id'
    ],
    order: [[fn('MIN', col('KYC_Request.createdAt')), 'DESC'], ['submission_id', 'DESC']],
    limit: pageSize,
    offset: (page - 1) * pageSize,
    subQuery: false
  });

  const totalItems = Array.isArray(result.count) ? result.count.length : Number(result.count) || 0;
  return {
    items: result.rows.map(toListItem),
    pagination: {
      page,
      page_size: pageSize,
      total_items: totalItems,
      total_pages: Math.ceil(totalItems / pageSize)
    }
  };
};

const getSubmissionHistory = async (userId) => {
  const rows = await KycRequest.findAll({
    attributes: [
      'submission_id',
      'submission_sequence',
      'status',
      [fn('MIN', col('createdAt')), 'submitted_at'],
      [fn('MAX', col('reviewed_at')), 'reviewed_at'],
      [fn('COUNT', col('id')), 'document_count']
    ],
    where: { user_id: userId, submission_id: { [Op.ne]: null } },
    group: ['submission_id', 'submission_sequence', 'status'],
    order: [['submission_sequence', 'DESC']]
  });
  return rows.map((row) => {
    const value = row.get({ plain: true });
    return {
      id: value.submission_id,
      submission_sequence: value.submission_sequence,
      status: value.status,
      submitted_at: value.submitted_at,
      reviewed_at: value.reviewed_at,
      document_count: Number(value.document_count) || 0
    };
  });
};

const getKycRequestDetailService = async (submissionId) => {
  assertUuid(submissionId, 'submissionId');
  const documents = await KycRequest.findAll({
    where: { submission_id: submissionId },
    include: [{
      model: User,
      as: 'Owner',
      attributes: ['id', 'full_name', 'email', 'role', 'phone_number', 'avatar_url', 'kyc_status']
    }],
    order: [['document_type', 'ASC']]
  });
  if (documents.length === 0) {
    throw new AdminKycError('KYC request not found.', 404, 'KYC_REQUEST_NOT_FOUND');
  }

  const first = documents[0];
  const owner = first.Owner.get({ plain: true });
  const status = first.status;
  const requiredCount = getRequiredCount(owner.role);
  const requiredTypes = KYC_REQUIRED_DOCUMENTS[owner.role] || [];
  const actualTypes = new Set(documents.map((document) => document.document_type));
  const isConsistent = documents.every((document) => (
    document.user_id === first.user_id
    && document.submission_sequence === first.submission_sequence
    && document.status === status
  ));
  const isComplete = documents.length === requiredCount
    && requiredTypes.every((type) => actualTypes.has(type));
  const allowedActions = [ADMIN_KYC_ACTIONS.VIEW_DOCUMENTS];
  if (status === 'PENDING' && owner.kyc_status === 'PENDING' && isConsistent && isComplete) {
    allowedActions.push(ADMIN_KYC_ACTIONS.APPROVE, ADMIN_KYC_ACTIONS.REJECT);
  }

  return {
    id: first.submission_id,
    submission_sequence: first.submission_sequence,
    status,
    submitted_at: first.createdAt,
    reviewed_at: first.reviewed_at,
    reviewed_by_admin_id: first.reviewed_by_admin_id,
    rejection_reason_code: first.rejection_reason_code,
    rejection_reason_text: first.rejection_reason_text,
    user: owner,
    documents: documents.map((document) => ({
      id: document.id,
      document_type: document.document_type,
      mime_type: document.document_mime_type,
      uploaded_at: document.createdAt,
      can_view: Boolean(document.cloudinary_public_id)
    })),
    document_count: documents.length,
    required_document_count: requiredCount,
    is_complete: isComplete,
    history: await getSubmissionHistory(owner.id),
    allowed_actions: allowedActions
  };
};

const getKycDocumentAccessService = async ({ submissionId, documentId }) => {
  assertUuid(submissionId, 'submissionId');
  assertUuid(documentId, 'documentId');
  const document = await KycRequest.findOne({
    where: { id: documentId, submission_id: submissionId }
  });
  if (!document) {
    throw new AdminKycError('KYC document not found.', 404, 'KYC_REQUEST_NOT_FOUND');
  }
  if (!document.cloudinary_public_id || document.cloudinary_delivery_type !== 'authenticated') {
    throw new AdminKycError('This legacy KYC document is not available through the private viewer.', 403, 'KYC_DOCUMENT_ACCESS_FORBIDDEN');
  }

  const ttlSeconds = Math.max(60, Number.parseInt(process.env.KYC_SIGNED_URL_TTL_SECONDS, 10) || 600);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  return {
    url: createSignedCloudinaryImageUrl({
      publicId: document.cloudinary_public_id,
      format: document.cloudinary_format,
      expiresAt
    }),
    expires_at: expiresAt.toISOString()
  };
};

const validateDecision = (payload = {}) => {
  const decision = String(payload.decision || '').trim().toUpperCase();
  if (!['APPROVE', 'REJECT'].includes(decision)) {
    throw new AdminKycError('Decision must be APPROVE or REJECT.', 400, 'KYC_DECISION_INVALID');
  }
  const reasonCode = payload.reason_code ? String(payload.reason_code).trim().toUpperCase() : null;
  const rawReasonText = payload.reason_text ? String(payload.reason_text).trim() : null;
  if (rawReasonText && /[\u0000-\u001f\u007f-\u009f]/.test(rawReasonText)) {
    throw new AdminKycError('The rejection note contains unsupported control characters.', 400, 'KYC_REJECTION_REASON_INVALID');
  }
  const reasonText = rawReasonText ? rawReasonText.replace(/\s+/g, ' ') : null;
  if (decision === 'APPROVE') {
    if (reasonCode || reasonText) {
      throw new AdminKycError('Approval must not include a rejection reason.', 400, 'KYC_DECISION_INVALID');
    }
    return { decision, reasonCode: null, reasonText: null };
  }
  if (!reasonCode) {
    throw new AdminKycError('A rejection reason is required.', 400, 'KYC_REJECTION_REASON_REQUIRED');
  }
  if (!KYC_REJECTION_REASONS.includes(reasonCode)) {
    throw new AdminKycError('The rejection reason is invalid.', 400, 'KYC_REJECTION_REASON_INVALID');
  }
  if (reasonCode === 'OTHER' && !reasonText) {
    throw new AdminKycError('A note is required when the rejection reason is OTHER.', 400, 'KYC_REJECTION_REASON_REQUIRED');
  }
  if (reasonText && (reasonText.length > 500 || /<\/?[a-z][^>]*>/i.test(reasonText) || /[\u0000-\u001f\u007f]/.test(reasonText))) {
    throw new AdminKycError('The rejection note is invalid or longer than 500 characters.', 400, 'KYC_REJECTION_REASON_INVALID');
  }
  return { decision, reasonCode, reasonText };
};

const reviewKycRequestService = async ({ submissionId, admin, payload, requestMeta }) => {
  assertUuid(submissionId, 'submissionId');
  const { decision, reasonCode, reasonText } = validateDecision(payload);
  const transaction = await db.transaction();
  let userId;
  let submissionSequence;
  try {
    const documents = await KycRequest.findAll({
      where: { submission_id: submissionId },
      transaction,
      lock: transaction.LOCK.UPDATE,
      order: [['document_type', 'ASC']]
    });
    if (documents.length === 0) {
      throw new AdminKycError('KYC request not found.', 404, 'KYC_REQUEST_NOT_FOUND');
    }
    if (documents.some((document) => document.status !== 'PENDING')) {
      throw new AdminKycError('This KYC request has already been reviewed.', 409, 'KYC_REQUEST_ALREADY_REVIEWED');
    }

    userId = documents[0].user_id;
    submissionSequence = documents[0].submission_sequence;
    if (documents.some((document) => document.user_id !== userId || document.submission_sequence !== submissionSequence)) {
      throw new AdminKycError('The KYC request source state has changed.', 409, 'SOURCE_STATE_CHANGED');
    }

    const user = await User.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!user) throw new AdminKycError('KYC user not found.', 404, 'KYC_USER_NOT_FOUND');
    if (!['CUSTOMER', 'HANDYMAN'].includes(user.role) || user.kyc_status !== 'PENDING') {
      throw new AdminKycError('The KYC user source state has changed.', 409, 'SOURCE_STATE_CHANGED');
    }

    const requiredTypes = KYC_REQUIRED_DOCUMENTS[user.role];
    const actualTypes = new Set(documents.map((document) => document.document_type));
    if (documents.length !== requiredTypes.length || requiredTypes.some((type) => !actualTypes.has(type))) {
      throw new AdminKycError('The KYC document set is incomplete.', 409, 'SOURCE_STATE_CHANGED');
    }

    let handymanProfile = null;
    if (user.role === 'HANDYMAN' && decision === 'APPROVE') {
      handymanProfile = await HandymanProfile.findOne({
        where: { user_id: user.id },
        transaction,
        lock: transaction.LOCK.UPDATE
      });
      if (!handymanProfile) throw new AdminKycError('Handyman profile not found.', 409, 'SOURCE_STATE_CHANGED');
    }

    const reviewedAt = new Date();
    const documentStatus = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    const userStatus = decision === 'APPROVE' ? 'VERIFIED' : 'REJECTED';
    const beforeState = {
      submission_id: submissionId,
      submission_sequence: submissionSequence,
      user_id: user.id,
      user_role: user.role,
      request_status: 'PENDING',
      user_kyc_status: user.kyc_status,
      document_types: [...actualTypes].sort()
    };

    const [updatedCount] = await KycRequest.update({
      status: documentStatus,
      admin_notes: reasonText,
      rejection_reason_code: reasonCode,
      rejection_reason_text: reasonText,
      reviewed_by_admin_id: admin.id,
      reviewed_at: reviewedAt
    }, {
      where: { submission_id: submissionId, status: 'PENDING' },
      transaction
    });
    if (updatedCount !== documents.length) {
      throw new AdminKycError('The KYC request source state has changed.', 409, 'SOURCE_STATE_CHANGED');
    }

    await user.update({ kyc_status: userStatus }, { transaction });
    if (handymanProfile) {
      await handymanProfile.update({ handyman_level: 'C2' }, { transaction });
    }

    await createAdminAuditLog({
      adminId: admin.id,
      action: decision === 'APPROVE' ? ADMIN_AUDIT_ACTIONS.KYC_APPROVED : ADMIN_AUDIT_ACTIONS.KYC_REJECTED,
      targetType: ADMIN_AUDIT_TARGETS.KYC_SUBMISSION,
      targetId: submissionId,
      reasonCode,
      reasonText,
      beforeState,
      afterState: {
        ...beforeState,
        request_status: documentStatus,
        user_kyc_status: userStatus,
        reviewed_by_admin_id: admin.id,
        reviewed_at: reviewedAt.toISOString()
      },
      correlationId: requestMeta.correlationId,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      transaction
    });

    await transaction.commit();

    const occurredAt = new Date().toISOString();
    try {
      emitToRole('ADMIN', KYC_REALTIME_EVENTS.ADMIN_QUEUE_UPDATED, {
        event_id: crypto.randomUUID(),
        occurred_at: occurredAt,
        queue: 'KYC'
      });
      emitToUsers([userId], KYC_REALTIME_EVENTS.REVIEWED, {
        event_id: crypto.randomUUID(),
        occurred_at: occurredAt,
        resource: 'KYC'
      });
    } catch (realtimeError) {
      console.error('[admin-kyc] Decision committed but realtime notification failed.', {
        correlation_id: requestMeta.correlationId,
        submission_id: submissionId,
        error: realtimeError.message
      });
    }

    return {
      id: submissionId,
      submission_sequence: submissionSequence,
      status: documentStatus,
      user_kyc_status: userStatus,
      reviewed_at: reviewedAt.toISOString()
    };
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    if (error instanceof AdminKycError) throw error;
    console.error('[admin-kyc] Review failed.', {
      correlation_id: requestMeta.correlationId,
      submission_id: submissionId,
      error: error.message
    });
    throw new AdminKycError('Unable to review the KYC request.', 500, 'INTERNAL_SERVER_ERROR');
  }
};

export {
  AdminKycError,
  getKycDocumentAccessService,
  getKycRequestDetailService,
  getKycRequestsService,
  reviewKycRequestService
};
