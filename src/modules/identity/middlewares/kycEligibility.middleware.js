import User from '../models/User.model.js';

const requireKycSubmissionEligibility = (expectedRole) => async (req, res, next) => {
  try {
    const user = await User.findByPk(req.user?.id, {
      attributes: ['id', 'role', 'is_active', 'kyc_status']
    });
    if (!user) {
      return res.status(404).json({ EM: 'User not found.', EC: 404, code: 'KYC_USER_NOT_FOUND', DT: '' });
    }
    if (!user.is_active) {
      return res.status(403).json({ EM: 'User account is inactive.', EC: 403, code: 'ACCOUNT_INACTIVE', DT: '' });
    }
    if (user.role !== expectedRole) {
      return res.status(403).json({
        EM: `Only ${expectedRole.toLowerCase()} accounts may use this KYC submission flow.`,
        EC: 403,
        code: 'KYC_SUBMISSION_ROLE_REQUIRED',
        DT: ''
      });
    }
    if (user.kyc_status === 'PENDING') {
      return res.status(409).json({
        EM: 'Your KYC request is already pending review.',
        EC: 409,
        code: 'KYC_REQUEST_ALREADY_PENDING',
        DT: ''
      });
    }
    if (user.kyc_status === 'VERIFIED') {
      return res.status(409).json({
        EM: 'Your account is already verified.',
        EC: 409,
        code: 'KYC_ALREADY_VERIFIED',
        DT: ''
      });
    }
    if (!['UNVERIFIED', 'REJECTED'].includes(user.kyc_status)) {
      return res.status(409).json({
        EM: 'Your current KYC state does not allow a new submission.',
        EC: 409,
        code: 'KYC_SUBMISSION_NOT_ALLOWED',
        DT: ''
      });
    }
    req.kycUser = user;
    return next();
  } catch (error) {
    console.error('[kyc] Eligibility check failed.', {
      correlation_id: req.correlationId,
      error: error.message
    });
    return res.status(500).json({ EM: 'Unable to validate KYC eligibility.', EC: 500, code: 'INTERNAL_SERVER_ERROR', DT: '' });
  }
};

export { requireKycSubmissionEligibility };
