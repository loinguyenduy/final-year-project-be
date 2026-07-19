const parseBoolean = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (String(value).toLowerCase() === 'true') return true;
  if (String(value).toLowerCase() === 'false') return false;
  throw new Error('COOKIE_SECURE must be true or false.');
};

const parseMaxAge = () => {
  const raw = process.env.COOKIE_REFRESH_MAX_AGE_MS
    ?? process.env.COOKIE_REFRESH_MAX_AGE
    ?? 7 * 24 * 60 * 60 * 1000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('COOKIE_REFRESH_MAX_AGE_MS must be a positive number.');
  }
  return Math.floor(parsed);
};

const getRefreshCookieOptions = () => {
  const isProduction = String(process.env.NODE_ENV || 'development').toLowerCase() === 'production';
  const sameSite = String(process.env.COOKIE_SAME_SITE || 'strict').toLowerCase();
  if (!['strict', 'lax', 'none'].includes(sameSite)) {
    throw new Error('COOKIE_SAME_SITE must be strict, lax, or none.');
  }

  const secure = parseBoolean(process.env.COOKIE_SECURE, isProduction);
  if (sameSite === 'none' && !secure) {
    throw new Error('COOKIE_SECURE must be true when COOKIE_SAME_SITE is none.');
  }

  const options = {
    httpOnly: true,
    secure,
    sameSite,
    path: '/',
    maxAge: parseMaxAge()
  };
  const domain = String(process.env.COOKIE_DOMAIN || '').trim();
  if (domain) options.domain = domain;
  return options;
};

const getRefreshCookieClearOptions = () => {
  const { maxAge: _maxAge, httpOnly: _httpOnly, ...options } = getRefreshCookieOptions();
  return { ...options, httpOnly: true };
};

const setRefreshCookie = (res, refreshToken) => {
  res.cookie('refreshToken', refreshToken, getRefreshCookieOptions());
};

const clearRefreshCookie = (res) => {
  res.clearCookie('refreshToken', getRefreshCookieClearOptions());
};

export {
  clearRefreshCookie,
  getRefreshCookieOptions,
  setRefreshCookie
};
