const KYC_DOCUMENT_FIELDS = Object.freeze({
  cccd_front: 'CCCD_FRONT',
  cccd_back: 'CCCD_BACK',
  portrait: 'SELFIE',
  certificate: 'CERTIFICATE',
  cv: 'CV'
});

const KYC_REQUIRED_DOCUMENTS = Object.freeze({
  CUSTOMER: Object.freeze(['CCCD_FRONT', 'CCCD_BACK', 'SELFIE']),
  HANDYMAN: Object.freeze(['CCCD_FRONT', 'CCCD_BACK', 'SELFIE', 'CERTIFICATE', 'CV'])
});

const KYC_REJECTION_REASONS = Object.freeze([
  'DOCUMENT_UNCLEAR',
  'DOCUMENT_EXPIRED',
  'INFORMATION_MISMATCH',
  'MISSING_REQUIRED_DOCUMENT',
  'SUSPECTED_ALTERATION',
  'FACE_OR_IDENTITY_MISMATCH',
  'OTHER'
]);

const KYC_REJECTION_MESSAGES = Object.freeze({
  DOCUMENT_UNCLEAR: 'One or more submitted documents are not clear enough to verify.',
  DOCUMENT_EXPIRED: 'One or more submitted documents have expired.',
  INFORMATION_MISMATCH: 'The submitted information does not match the account information.',
  MISSING_REQUIRED_DOCUMENT: 'One or more required documents are missing.',
  SUSPECTED_ALTERATION: 'One or more submitted documents may have been altered.',
  FACE_OR_IDENTITY_MISMATCH: 'The portrait does not match the submitted identification document.',
  OTHER: 'The KYC submission could not be verified.'
});

const KYC_REALTIME_EVENTS = Object.freeze({
  ADMIN_QUEUE_UPDATED: 'ADMIN_KYC_QUEUE_UPDATED',
  REVIEWED: 'KYC_REVIEWED'
});

export {
  KYC_DOCUMENT_FIELDS,
  KYC_REALTIME_EVENTS,
  KYC_REJECTION_MESSAGES,
  KYC_REJECTION_REASONS,
  KYC_REQUIRED_DOCUMENTS
};
