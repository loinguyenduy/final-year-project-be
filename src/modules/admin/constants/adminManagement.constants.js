const PARTICIPANT_ROLES = Object.freeze(['CUSTOMER', 'HANDYMAN']);

const ACCOUNT_REASON_CODES = Object.freeze([
  'POLICY_VIOLATION',
  'FRAUD_SUSPECTED',
  'SECURITY_RISK',
  'ABUSIVE_BEHAVIOR',
  'USER_REQUEST',
  'DUPLICATE_ACCOUNT',
  'OTHER'
]);

const ACCOUNT_ACTIONS = Object.freeze({
  DEACTIVATE: 'DEACTIVATE_USER',
  REACTIVATE: 'REACTIVATE_USER'
});

const buildAccountDecisionRequirements = (action) => ({
  action,
  reason_codes: ACCOUNT_REASON_CODES,
  reason_text_required_for: ['OTHER'],
  reason_text_max_length: 500
});

export {
  ACCOUNT_ACTIONS,
  ACCOUNT_REASON_CODES,
  PARTICIPANT_ROLES,
  buildAccountDecisionRequirements
};
