import { getAdminReviewCases } from '../services/AdminReviewQuery.service.js';
import { decideWarrantyClaim, decideWarrantyRework } from '../services/AdminWarrantyReview.service.js';
import { decideCancellation } from '../services/AdminCancellationReview.service.js';
import {
  getReviewCaseDetail,
  getReviewChat,
  getReviewEvidenceAccess
} from '../services/AdminReviewAccess.service.js';
import { AdminReviewError } from '../utils/adminReviewValidation.util.js';

const handleAdminReviewError = (req, res, error) => {
  if (error instanceof AdminReviewError) {
    return res.status(error.status).json({
      EM: error.message,
      EC: error.status,
      code: error.code,
      DT: ''
    });
  }
  console.error('[admin-review] Unexpected controller error.', {
    correlation_id: req.correlationId,
    error: error.message
  });
  return res.status(500).json({
    EM: 'Unable to process the Admin Review request.',
    EC: 500,
    code: 'INTERNAL_SERVER_ERROR',
    DT: ''
  });
};

const listReviewCases = async (req, res) => {
  try {
    return res.status(200).json({
      EM: 'Review cases retrieved successfully.',
      EC: 0,
      code: 'ADMIN_REVIEW_CASES_RETRIEVED',
      DT: await getAdminReviewCases(req.query)
    });
  } catch (error) {
    return handleAdminReviewError(req, res, error);
  }
};

const decideWarrantyClaimController = async (req, res) => {
  try {
    const data = await decideWarrantyClaim({
      claimId: req.params.claimId,
      admin: req.admin,
      payload: req.body,
      requestMeta: {
        correlationId: req.correlationId,
        ipAddress: req.ip,
        userAgent: req.get('user-agent') || null
      }
    });
    return res.status(200).json({
      EM: data.replayed ? 'Administrator decision replayed successfully.' : 'Warranty Claim decision completed successfully.',
      EC: 0,
      code: data.replayed ? 'ADMIN_DECISION_REPLAYED' : 'ADMIN_WARRANTY_CLAIM_DECIDED',
      DT: data
    });
  } catch (error) {
    return handleAdminReviewError(req, res, error);
  }
};

const decideWarrantyReworkController = async (req, res) => {
  try {
    const data = await decideWarrantyRework({
      requestId: req.params.requestId,
      admin: req.admin,
      payload: req.body,
      requestMeta: {
        correlationId: req.correlationId,
        ipAddress: req.ip,
        userAgent: req.get('user-agent') || null
      }
    });
    return res.status(200).json({
      EM: data.replayed ? 'Administrator decision replayed successfully.' : 'Warranty Rework decision completed successfully.',
      EC: 0,
      code: data.replayed ? 'ADMIN_DECISION_REPLAYED' : 'ADMIN_WARRANTY_REWORK_DECIDED',
      DT: data
    });
  } catch (error) {
    return handleAdminReviewError(req, res, error);
  }
};

const decideCancellationController = async (req, res) => {
  try {
    const data = await decideCancellation({
      cancellationId: req.params.cancellationId,
      admin: req.admin,
      payload: req.body,
      requestMeta: {
        correlationId: req.correlationId,
        ipAddress: req.ip,
        userAgent: req.get('user-agent') || null
      }
    });
    return res.status(200).json({
      EM: data.replayed ? 'Administrator decision replayed successfully.' : 'Cancellation decision completed successfully.',
      EC: 0,
      code: data.replayed ? 'ADMIN_DECISION_REPLAYED' : 'ADMIN_CANCELLATION_DECIDED',
      DT: data
    });
  } catch (error) {
    return handleAdminReviewError(req, res, error);
  }
};

const getReviewCaseDetailController = async (req, res) => {
  try {
    return res.status(200).json({
      EM: 'Review case detail retrieved successfully.',
      EC: 0,
      code: 'ADMIN_REVIEW_CASE_RETRIEVED',
      DT: await getReviewCaseDetail(req.params)
    });
  } catch (error) {
    return handleAdminReviewError(req, res, error);
  }
};

const getReviewEvidenceAccessController = async (req, res) => {
  try {
    const data = await getReviewEvidenceAccess({
      ...req.params,
      admin: req.admin,
      correlationId: req.correlationId
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      EM: 'Review Evidence access granted.',
      EC: 0,
      code: 'ADMIN_REVIEW_EVIDENCE_ACCESS_GRANTED',
      DT: data
    });
  } catch (error) {
    return handleAdminReviewError(req, res, error);
  }
};

const getReviewChatController = async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      EM: 'Review Chat transcript retrieved successfully.',
      EC: 0,
      code: 'ADMIN_REVIEW_CHAT_RETRIEVED',
      DT: await getReviewChat({
        ...req.params,
        cursor: req.query.cursor,
        limit: req.query.limit,
        admin: req.admin,
        correlationId: req.correlationId
      })
    });
  } catch (error) {
    return handleAdminReviewError(req, res, error);
  }
};

export {
  decideCancellationController,
  decideWarrantyClaimController,
  decideWarrantyReworkController,
  getReviewCaseDetailController,
  getReviewChatController,
  getReviewEvidenceAccessController,
  handleAdminReviewError,
  listReviewCases
};
