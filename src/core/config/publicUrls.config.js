const DEVELOPMENT_FRONTEND_ORIGIN = 'http://localhost:5173';

const parseOrigin = (rawValue, variableName) => {
  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new Error(`${variableName} must be a valid HTTP or HTTPS origin.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${variableName} must be a valid HTTP or HTTPS origin.`);
  }
  if (!['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) {
    throw new Error(`${variableName} must not contain a path, query string, or fragment.`);
  }
  return parsed.origin;
};

const getFrontendOrigin = ({ required = true } = {}) => {
  const configured = String(process.env.FRONTEND_URL || '').trim();
  if (configured) return parseOrigin(configured, 'FRONTEND_URL');
  const isProduction = String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
  if (!isProduction) return DEVELOPMENT_FRONTEND_ORIGIN;
  if (!required) return null;
  throw new Error('FRONTEND_URL is required in production.');
};

const buildFrontendUrl = (pathname, query = {}) => {
  const relativePath = String(pathname || '').replace(/^\/+/, '');
  if (/^[a-z][a-z\d+.-]*:/i.test(relativePath) || relativePath.startsWith('//')) {
    throw new Error('Frontend redirect paths must be relative.');
  }
  const url = new URL(relativePath, `${getFrontendOrigin()}/`);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
};

export {
  DEVELOPMENT_FRONTEND_ORIGIN,
  buildFrontendUrl,
  getFrontendOrigin,
  parseOrigin,
};
