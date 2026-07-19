import {
  AdminKycError,
  getKycDocumentAccessService,
  getKycRequestDetailService,
  getKycRequestsService,
  reviewKycRequestService
} from '../services/AdminKyc.service.js';

const handleError = (req, res, error) => {
  if (error instanceof AdminKycError) {
    return res.status(error.status).json({ EM: error.message, EC: error.status, code: error.code, DT: '' });
  }
  console.error('[admin-kyc] Unexpected controller error.', {
    correlation_id: req.correlationId,
    error: error.message
  });
  return res.status(500).json({ EM: 'Internal server error.', EC: 500, code: 'INTERNAL_SERVER_ERROR', DT: '' });
};

const listKycRequests = async (req, res) => {
  try {
    return res.status(200).json({
      EM: 'KYC requests retrieved successfully.',
      EC: 0,
      code: 'KYC_REQUESTS_RETRIEVED',
      DT: await getKycRequestsService(req.query)
    });
  } catch (error) {
    return handleError(req, res, error);
  }
};

const getKycRequestDetail = async (req, res) => {
  try {
    return res.status(200).json({
      EM: 'KYC request retrieved successfully.',
      EC: 0,
      code: 'KYC_REQUEST_RETRIEVED',
      DT: await getKycRequestDetailService(req.params.submissionId)
    });
  } catch (error) {
    return handleError(req, res, error);
  }
};

const getKycDocumentAccess = async (req, res) => {
  try {
    const data = await getKycDocumentAccessService({
      submissionId: req.params.submissionId,
      documentId: req.params.documentId
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      EM: 'KYC document access granted.',
      EC: 0,
      code: 'KYC_DOCUMENT_ACCESS_GRANTED',
      DT: data
    });
  } catch (error) {
    return handleError(req, res, error);
  }
};

const decideKycRequest = async (req, res) => {
  try {
    const data = await reviewKycRequestService({
      submissionId: req.params.submissionId,
      admin: req.admin,
      payload: req.body,
      requestMeta: {
        correlationId: req.correlationId,
        ipAddress: req.ip,
        userAgent: req.get('user-agent') || null
      }
    });
    return res.status(200).json({
      EM: `KYC request ${data.status === 'APPROVED' ? 'approved' : 'rejected'} successfully.`,
      EC: 0,
      code: data.status === 'APPROVED' ? 'KYC_REQUEST_APPROVED' : 'KYC_REQUEST_REJECTED',
      DT: data
    });
  } catch (error) {
    return handleError(req, res, error);
  }
};

export {
  decideKycRequest,
  getKycDocumentAccess,
  getKycRequestDetail,
  listKycRequests
};
