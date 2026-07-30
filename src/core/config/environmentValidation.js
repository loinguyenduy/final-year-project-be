const STAGES = Object.freeze(['bootstrap', 'runtime', 'full']);

const BOOTSTRAP_VARIABLES = Object.freeze([
  'NODE_ENV',
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'DB_USER',
  'DB_PASS',
  'DB_DIALECT',
  'DB_SYNC_ALTER',
  'JWT_ACCESS_SECRET',
  'JWT_ACCESS_EXPIRES_IN',
  'JWT_REFRESH_SECRET',
  'JWT_REFRESH_EXPIRES_IN',
]);

const RUNTIME_VARIABLES = Object.freeze([
  'FRONTEND_URL',
  'SOCKET_CORS_ORIGIN',
  'TRUST_PROXY',
  'COOKIE_SAME_SITE',
  'COOKIE_SECURE',
  'BACKEND_PUBLIC_URL',
]);

const FEATURE_VARIABLE_GROUPS = Object.freeze({
  payos: [
    'PAYOS_CLIENT_ID',
    'PAYOS_API_KEY',
    'PAYOS_CHECKSUM_KEY',
    'PAYOS_TOPUP_RETURN_URL',
    'PAYOS_TOPUP_CANCEL_URL',
  ],
  google_oauth: [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REDIRECT_URI',
  ],
  facebook_oauth: [
    'FACEBOOK_APP_ID',
    'FACEBOOK_APP_SECRET',
    'FACEBOOK_REDIRECT_URI',
  ],
  cloudinary: [
    'CLOUDINARY_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
  ],
  gemini: ['GEMINI_API_KEY', 'GEMINI_MODEL'],
  opencage: ['OPENCAGE_API_KEY'],
});

const hasValue = (environment, name) => {
  const value = environment[name];
  return value !== undefined && value !== null && String(value).trim() !== '';
};

const missingVariables = (environment, names) => names.filter((name) => !hasValue(environment, name));

const inspectEmailConfiguration = (environment) => {
  if (!hasValue(environment, 'EMAIL_TRANSPORT')) {
    return { errors: ['EMAIL_TRANSPORT is required.'], missing: ['EMAIL_TRANSPORT'] };
  }

  const transport = String(environment.EMAIL_TRANSPORT).trim().toLowerCase();
  if (transport === 'smtp') {
    const required = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM'];
    return { errors: [], missing: missingVariables(environment, required) };
  }
  if (transport === 'brevo-api') {
    const required = ['BREVO_API_KEY', 'EMAIL_FROM_ADDRESS', 'EMAIL_FROM_NAME'];
    return { errors: [], missing: missingVariables(environment, required) };
  }
  return {
    errors: ['EMAIL_TRANSPORT has an unsupported value.'],
    missing: [],
  };
};

const inspectEnvironment = ({ stage = 'full', environment = process.env } = {}) => {
  if (!STAGES.includes(stage)) {
    return {
      stage,
      errors: [`stage must be one of: ${STAGES.join(', ')}.`],
      missing: [],
      featureMissing: {},
    };
  }

  const required = [...BOOTSTRAP_VARIABLES];
  if (['runtime', 'full'].includes(stage)) required.push(...RUNTIME_VARIABLES);
  const missing = missingVariables(environment, required);
  const errors = [];
  const featureMissing = {};
  if (
    hasValue(environment, 'NODE_ENV')
    && String(environment.NODE_ENV).trim().toLowerCase() !== 'production'
  ) {
    errors.push('NODE_ENV must be production for deployment validation.');
  }
  if (
    hasValue(environment, 'DB_SYNC_ALTER')
    && !['true', 'false'].includes(String(environment.DB_SYNC_ALTER).trim().toLowerCase())
  ) {
    errors.push('DB_SYNC_ALTER must be true or false.');
  }

  if (stage === 'full') {
    Object.entries(FEATURE_VARIABLE_GROUPS).forEach(([group, names]) => {
      const groupMissing = missingVariables(environment, names);
      if (groupMissing.length) featureMissing[group] = groupMissing;
    });
    const email = inspectEmailConfiguration(environment);
    errors.push(...email.errors);
    if (email.missing.length) featureMissing.email = email.missing;
  }

  return { stage, errors, missing, featureMissing };
};

const assertEnvironment = (options = {}) => {
  const result = inspectEnvironment(options);
  const featureNames = Object.values(result.featureMissing).flat();
  if (result.errors.length || result.missing.length || featureNames.length) {
    const parts = [];
    if (result.errors.length) parts.push(result.errors.join(' '));
    if (result.missing.length) parts.push(`Missing required variables: ${result.missing.join(', ')}.`);
    Object.entries(result.featureMissing).forEach(([group, names]) => {
      parts.push(`Missing ${group} variables: ${names.join(', ')}.`);
    });
    throw new Error(parts.join(' '));
  }
  return result;
};

const assertProductionBootstrapEnvironment = (environment = process.env) => {
  const nodeEnvironment = String(environment.NODE_ENV || '').trim().toLowerCase();
  if (!nodeEnvironment || ['development', 'test'].includes(nodeEnvironment)) return null;
  if (nodeEnvironment !== 'production') {
    throw new Error('NODE_ENV must be production, development, or test.');
  }
  return assertEnvironment({ stage: 'bootstrap', environment });
};

export {
  BOOTSTRAP_VARIABLES,
  FEATURE_VARIABLE_GROUPS,
  RUNTIME_VARIABLES,
  STAGES,
  assertEnvironment,
  assertProductionBootstrapEnvironment,
  inspectEmailConfiguration,
  inspectEnvironment,
};
