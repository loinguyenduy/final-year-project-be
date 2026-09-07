import {
  buildOfficialHandymanPartnerRequiredError,
  getOfficialHandymanPartnerEligibility
} from '../services/HandymanPartnerEligibility.service.js';

// Middleware kiểm tra xem người dùng hiện tại có đủ điều kiện để trở thành 
// đối tác chính thức của Handyman hay không.
const requireOfficialHandymanPartner = async (req, res, next) => {
  try {
    const eligibility = await getOfficialHandymanPartnerEligibility(req.user?.id);
    if (!eligibility.eligible) {
      return res.status(403).json(buildOfficialHandymanPartnerRequiredError());
    }

    req.officialHandymanProfile = eligibility.profile;
    return next();
  } catch (error) {
    console.error('[handyman-partner] Eligibility check failed.', {
      correlation_id: req.correlationId,
      error: error.message
    });
    return res.status(500).json({
      EM: 'Unable to validate official Handyman partner eligibility.',
      EC: 500,
      code: 'INTERNAL_SERVER_ERROR',
      DT: ''
    });
  }
};

export { requireOfficialHandymanPartner };
