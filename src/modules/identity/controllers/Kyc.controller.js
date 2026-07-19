import {
  KycSubmissionError,
  submitCustomerKycService,
  submitHandymanKycService
} from '../services/Kyc.service.js';

const handleSubmission = (service, successMessage) => async (req, res) => {
  try {
    const data = await service(req.user.id, req.files, req.correlationId);
    return res.status(201).json({
      EM: successMessage,
      EC: 0,
      code: 'KYC_SUBMITTED',
      DT: data
    });
  } catch (error) {
    if (error instanceof KycSubmissionError) {
      return res.status(error.status).json({
        EM: error.message,
        EC: error.status,
        code: error.code,
        DT: ''
      });
    }
    console.error('[kyc] Unexpected controller error.', {
      correlation_id: req.correlationId,
      error: error.message
    });
    return res.status(500).json({
      EM: 'Internal server error.',
      EC: 500,
      code: 'INTERNAL_SERVER_ERROR',
      DT: ''
    });
  }
};

const handleSubmitKyc = handleSubmission(
  submitCustomerKycService,
  'KYC documents submitted successfully.'
);
const handleHandymanKyc = handleSubmission(
  submitHandymanKycService,
  'Handyman KYC documents submitted successfully.'
);

export { handleSubmitKyc, handleHandymanKyc };
