import { Op } from 'sequelize';
import User from '../../identity/models/User.model.js';
import Conversation from '../../chat/models/Conversation.model.js';
import Message from '../../chat/models/Message.model.js';
import { decodeMessageCursor, encodeMessageCursor } from '../../chat/utils/chatCursor.util.js';
import EContract from '../../fintech/models/EContract.model.js';
import EvidenceVault from '../../fintech/models/EvidenceVault.model.js';
import Transaction from '../../fintech/models/Transaction.model.js';
import Job from '../../matchmaking/models/Job.model.js';
import JobArrivalRequest from '../../matchmaking/models/JobArrivalRequest.model.js';
import JobCancellation from '../../matchmaking/models/JobCancellation.model.js';
import JobStatusHistory from '../../matchmaking/models/JobStatusHistory.model.js';
import JobWarranty from '../../matchmaking/models/JobWarranty.model.js';
import Service from '../../matchmaking/models/Service.model.js';
import WarrantyClaim from '../../matchmaking/models/WarrantyClaim.model.js';
import WarrantyClaimEvidence from '../../matchmaking/models/WarrantyClaimEvidence.model.js';
import WarrantyCompletionRequest from '../../matchmaking/models/WarrantyCompletionRequest.model.js';
import WarrantyCompletionRequestEvidence from '../../matchmaking/models/WarrantyCompletionRequestEvidence.model.js';
import AdminAuditLog from '../models/AdminAuditLog.model.js';
import {
  REVIEW_ACTIONS,
  REVIEW_CASE_TYPES,
  REVIEW_TARGET_TYPE
} from '../constants/adminReview.constants.js';
import { AdminReviewError, isValidUuid } from '../utils/adminReviewValidation.util.js';
import { logSensitiveAdminRead } from './AdminSecurityReadLog.service.js';

const CASE_TYPES = Object.values(REVIEW_CASE_TYPES);
const targetTypeForCase = (caseType) => ({
  [REVIEW_CASE_TYPES.WARRANTY_CLAIM]: REVIEW_TARGET_TYPE.WARRANTY_CLAIM,
  [REVIEW_CASE_TYPES.WARRANTY_REWORK]: REVIEW_TARGET_TYPE.WARRANTY_REWORK,
  [REVIEW_CASE_TYPES.CANCELLATION]: REVIEW_TARGET_TYPE.CANCELLATION
})[caseType];

const normalizeCaseIdentity = (caseType, caseId) => {
  const normalizedType = String(caseType || '').trim().toUpperCase();
  if (!CASE_TYPES.includes(normalizedType) || !isValidUuid(caseId)) {
    throw new AdminReviewError('Review case identity is invalid.', 400, 'VALIDATION_ERROR');
  }
  return { caseType: normalizedType, caseId };
};

const loadCanonicalCase = async (caseType, caseId) => {
  const identity = normalizeCaseIdentity(caseType, caseId);
  let record;
  if (identity.caseType === REVIEW_CASE_TYPES.WARRANTY_CLAIM) {
    record = await WarrantyClaim.findByPk(caseId);
  } else if (identity.caseType === REVIEW_CASE_TYPES.WARRANTY_REWORK) {
    record = await WarrantyCompletionRequest.findByPk(caseId);
  } else {
    record = await JobCancellation.findByPk(caseId);
    if (record?.status === null) record = null;
  }
  if (!record) throw new AdminReviewError('Review case was not found.', 404, 'REVIEW_CASE_NOT_FOUND');
  const job = await Job.findByPk(record.job_id, {
    include: [
      { model: User, as: 'Customer', attributes: ['id', 'full_name', 'email'] },
      { model: User, as: 'SelectedHandyman', attributes: ['id', 'full_name', 'email'] },
      { model: Service, attributes: ['id', 'name'] }
    ]
  });
  if (!job || Number(record.acceptance_cycle) !== Number(job.acceptance_cycle)) {
    throw new AdminReviewError('Review case source state is inconsistent.', 409, 'SOURCE_STATE_CHANGED');
  }
  return { ...identity, record, job };
};

const loadEvidenceIds = async ({ caseType, record, job }) => {
  if (caseType === REVIEW_CASE_TYPES.WARRANTY_CLAIM) {
    const links = await WarrantyClaimEvidence.findAll({ where: { claim_id: record.id }, attributes: ['evidence_id'] });
    return links.map((link) => link.evidence_id);
  }
  if (caseType === REVIEW_CASE_TYPES.WARRANTY_REWORK) {
    const links = await WarrantyCompletionRequestEvidence.findAll({
      where: { warranty_completion_request_id: record.id },
      attributes: ['evidence_id']
    });
    return links.map((link) => link.evidence_id);
  }
  const evidence = await EvidenceVault.findAll({
    where: { job_id: job.id, acceptance_cycle: job.acceptance_cycle },
    attributes: ['id']
  });
  return evidence.map((entry) => entry.id);
};

const allowedActions = async ({ caseType, record, job }) => {
  if (caseType === REVIEW_CASE_TYPES.WARRANTY_CLAIM) {
    const warranty = await JobWarranty.findByPk(record.warranty_id);
    return record.status === 'PENDING_REVIEW' && warranty?.status === 'CLAIM_PENDING'
      && !warranty.released_at && !warranty.refunded_at && job.current_status === 'WARRANTY'
      ? [REVIEW_ACTIONS.APPROVE_REWORK, REVIEW_ACTIONS.REJECT_CLAIM] : [];
  }
  if (caseType === REVIEW_CASE_TYPES.WARRANTY_REWORK) {
    const [warranty, claim, latest] = await Promise.all([
      JobWarranty.findByPk(record.warranty_id),
      WarrantyClaim.findByPk(record.claim_id),
      WarrantyCompletionRequest.findOne({ where: { warranty_id: record.warranty_id }, order: [['request_sequence', 'DESC']] })
    ]);
    if (record.id !== latest?.id || record.status !== 'REJECTED' || warranty?.status !== 'REVIEW_REQUIRED'
        || warranty.released_at || warranty.refunded_at
        || claim?.status !== 'REVIEW_REQUIRED' || job.current_status !== 'WARRANTY') return [];
    return [
      ...(Number(record.request_sequence) < 2 ? [REVIEW_ACTIONS.ALLOW_ANOTHER_REWORK] : []),
      REVIEW_ACTIONS.RELEASE_WARRANTY_RESERVE,
      REVIEW_ACTIONS.REFUND_WARRANTY_RESERVE
    ];
  }
  return record.status === 'REVIEW_REQUIRED' && job.current_status === 'CANCELLATION_REVIEW'
    ? [
      REVIEW_ACTIONS.RESOLVE_CANCELLATION_CUSTOMER_FAULT,
      REVIEW_ACTIONS.RESOLVE_CANCELLATION_HANDYMAN_FAULT,
      REVIEW_ACTIONS.RESOLVE_CANCELLATION_NEUTRAL
    ] : [];
};

const evidenceMetadata = (entry) => ({
  id: entry.id,
  stage: entry.stage,
  media_type: entry.media_type,
  mime_type: entry.mime_type,
  file_size: entry.file_size,
  uploader_id: entry.uploader_id,
  uploaded_at: entry.uploaded_at
});

const getReviewCaseDetail = async ({ caseType, caseId }) => {
  const context = await loadCanonicalCase(caseType, caseId);
  const evidenceIds = await loadEvidenceIds(context);
  const [evidence, history, audits, contract, warranty, arrival, transactions, actions] = await Promise.all([
    evidenceIds.length ? EvidenceVault.findAll({ where: { id: { [Op.in]: evidenceIds } }, order: [['uploaded_at', 'ASC']] }) : [],
    JobStatusHistory.findAll({
      where: { job_id: context.job.id },
      attributes: ['id', 'old_status', 'new_status', 'reason', 'changed_by_user_id', 'createdAt'],
      order: [['createdAt', 'ASC']]
    }),
    AdminAuditLog.findAll({
      where: { target_type: targetTypeForCase(context.caseType), target_id: context.caseId },
      attributes: ['id', 'admin_id', 'action', 'reason_code', 'reason_text', 'before_state', 'after_state', 'createdAt'],
      order: [['createdAt', 'ASC']]
    }),
    EContract.findOne({ where: { job_id: context.job.id, acceptance_cycle: context.job.acceptance_cycle } }),
    JobWarranty.findOne({ where: { job_id: context.job.id, acceptance_cycle: context.job.acceptance_cycle } }),
    context.caseType === REVIEW_CASE_TYPES.CANCELLATION
      ? JobArrivalRequest.findOne({ where: { job_id: context.job.id, acceptance_cycle: context.job.acceptance_cycle }, order: [['requested_at', 'DESC']] })
      : null,
    Transaction.findAll({
      where: {
        job_id: context.job.id,
        transaction_type: { [Op.in]: ['WARRANTY_RESERVE_HOLD', 'WARRANTY_RELEASE', 'WARRANTY_REFUND', 'CANCELLATION_REFUND', 'CANCELLATION_COMPENSATION'] }
      },
      attributes: ['id', 'transaction_type', 'amount', 'status', 'createdAt'],
      order: [['createdAt', 'ASC']]
    }),
    allowedActions(context)
  ]);
  const record = context.record.toJSON();
  const participantMessageCode = context.caseType === REVIEW_CASE_TYPES.WARRANTY_CLAIM
    && record.status === 'REJECTED' && warranty?.status === 'COMPLETED'
    ? 'CLAIM_REJECTED_WARRANTY_EXPIRED_RELEASED' : null;
  return {
    case_id: context.caseId,
    case_type: context.caseType,
    review_status: actions.length ? 'PENDING' : audits.length ? 'RESOLVED' : 'NOT_ACTIONABLE',
    job: {
      id: context.job.id,
      status: context.job.current_status,
      acceptance_cycle: Number(context.job.acceptance_cycle),
      service_name: context.job.Service?.name || null,
      issue_description: context.job.issue_description,
      masked_address: [context.job.ward_code, context.job.province_code].filter(Boolean).join(', ') || null
    },
    parties: {
      customer: context.job.Customer,
      handyman: context.job.SelectedHandyman
    },
    case: record,
    warranty: warranty ? {
      id: warranty.id,
      status: warranty.status,
      ends_at: warranty.ends_at,
      held_amount: String(warranty.warranty_held_amount),
      released_amount: String(warranty.warranty_released_amount),
      refunded_amount: String(warranty.warranty_refunded_amount || 0)
    } : null,
    contract: contract ? {
      id: contract.id,
      contract_number: contract.contract_number,
      status: contract.status,
      quote_total_amount: String(contract.quote_total_amount),
      deposit_amount: String(contract.deposit_amount),
      remaining_payment_amount: String(contract.remaining_payment_amount),
      warranty_days: Number(contract.warranty_days)
    } : null,
    location_review: arrival ? {
      movement_started: ['ARRIVED', 'QUOTE_PENDING', 'PAYMENT_PENDING'].includes(record.status_when_cancelled),
      snapshot_distance_meters: arrival.distance_to_job_meters,
      arrival_requested_at: arrival.requested_at,
      arrival_outcome: arrival.status,
      threshold_result: arrival.location_warning
    } : null,
    evidence: evidence.map(evidenceMetadata),
    chat: { available: Boolean(await Conversation.findOne({ where: { job_id: context.job.id, acceptance_cycle: context.job.acceptance_cycle }, attributes: ['id'] })) },
    job_history: history,
    admin_decisions: audits,
    financial_ledger: transactions,
    allowed_actions: actions,
    participant_message_code: participantMessageCode
  };
};

const getReviewEvidenceAccess = async ({ caseType, caseId, evidenceId, admin, correlationId }) => {
  if (!isValidUuid(evidenceId)) throw new AdminReviewError('evidenceId must be a valid UUID.');
  const context = await loadCanonicalCase(caseType, caseId);
  const allowedIds = await loadEvidenceIds(context);
  if (!allowedIds.includes(evidenceId)) {
    throw new AdminReviewError('Evidence was not found for this Review case.', 404, 'REVIEW_EVIDENCE_NOT_FOUND');
  }
  const evidence = await EvidenceVault.findByPk(evidenceId);
  if (!evidence?.media_url) throw new AdminReviewError('Evidence is unavailable.', 404, 'REVIEW_EVIDENCE_NOT_FOUND');
  logSensitiveAdminRead({ adminId: admin.id, caseType: context.caseType, caseId, resourceType: 'EVIDENCE', correlationId });
  return { url: evidence.media_url, expires_at: null, delivery: 'LEGACY_PUBLIC_AUTHORIZED_GATE' };
};

const parseChatLimit = (value) => {
  const parsed = value == null || value === '' ? 30 : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new AdminReviewError('limit must be between 1 and 100.');
  }
  return parsed;
};

const getReviewChat = async ({ caseType, caseId, cursor, limit, admin, correlationId }) => {
  const context = await loadCanonicalCase(caseType, caseId);
  const conversation = await Conversation.findOne({
    where: { job_id: context.job.id, acceptance_cycle: context.job.acceptance_cycle }
  });
  if (!conversation) return { conversation: null, messages: [], next_cursor: null, has_more: false };
  const pageSize = parseChatLimit(limit);
  let cursorWhere = {};
  if (cursor) {
    let decoded;
    try {
      decoded = decodeMessageCursor(cursor, conversation.id);
    } catch {
      throw new AdminReviewError('Chat cursor is invalid.', 400, 'INVALID_CURSOR');
    }
    cursorWhere = {
      [Op.or]: [
        { createdAt: { [Op.lt]: decoded.createdAt } },
        { createdAt: decoded.createdAt, id: { [Op.lt]: decoded.id } }
      ]
    };
  }
  const rows = await Message.findAll({
    where: { conversation_id: conversation.id, ...cursorWhere },
    include: [{ model: User, as: 'Sender', attributes: ['id', 'full_name', 'role'] }],
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    limit: pageSize + 1
  });
  const hasMore = rows.length > pageSize;
  const descending = hasMore ? rows.slice(0, pageSize) : rows;
  const oldest = descending.at(-1);
  logSensitiveAdminRead({ adminId: admin.id, caseType: context.caseType, caseId, resourceType: 'CHAT', correlationId });
  return {
    conversation: { id: conversation.id, status: conversation.status, closed_at: conversation.closed_at },
    messages: [...descending].reverse().map((message) => ({
      id: message.id,
      sender: message.Sender,
      message_type: message.message_type,
      content: message.content,
      sent_at: message.createdAt
    })),
    has_more: hasMore,
    next_cursor: hasMore && oldest ? encodeMessageCursor({
      conversationId: conversation.id,
      createdAt: oldest.createdAt,
      id: oldest.id
    }) : null
  };
};

export { getReviewCaseDetail, getReviewChat, getReviewEvidenceAccess, loadCanonicalCase };
