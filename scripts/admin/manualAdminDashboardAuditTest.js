const enabled = String(process.env.ENABLE_ADMIN_PHASE4_MANUAL_TEST || '').toLowerCase() === 'true';
if (process.env.NODE_ENV === 'production' || !enabled) {
  console.error('Refusing to run. Use non-production NODE_ENV and ENABLE_ADMIN_PHASE4_MANUAL_TEST=true.');
  process.exit(1);
}

const baseUrl = String(process.env.ADMIN_PHASE4_BASE_URL || 'http://localhost:5000/api/v1').replace(/\/$/, '');
const forbiddenKeys = new Set([
  'password', 'password_hash', 'token', 'refresh_token', 'cookie', 'before_state', 'after_state',
  'idempotency_key', 'request_fingerprint', 'ip_address', 'user_agent', 'wallet_id', 'media_url',
  'cloudinary_public_id', 'gps_lat', 'gps_long', 'webhook_payload'
]);

const request = async (path, token, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.EC !== 0) throw new Error(`${path}: ${response.status} ${body.code || ''} ${body.EM || ''}`);
  if (response.headers.get('cache-control') !== 'private, no-store') throw new Error(`${path}: Cache-Control must be private, no-store.`);
  return body.DT;
};

const acquireToken = async () => {
  if (process.env.ADMIN_ACCESS_TOKEN) return process.env.ADMIN_ACCESS_TOKEN;
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
    throw new Error('Provide ADMIN_ACCESS_TOKEN, or ADMIN_EMAIL and ADMIN_PASSWORD for the audited login fallback.');
  }
  console.warn('No ADMIN_ACCESS_TOKEN provided. Credential fallback creates an immutable ADMIN_LOGIN_SUCCEEDED Audit record.');
  const response = await fetch(`${baseUrl}/auth/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD })
  });
  const body = await response.json();
  if (!response.ok || body.EC !== 0) throw new Error(`Admin login failed: ${body.code || response.status} ${body.EM || ''}`);
  const token = body.DT?.access_token || body.DT?.token;
  if (!token) throw new Error('Admin login did not return an access token.');
  return token;
};

const findForbiddenPaths = (value, path = '$', results = []) => {
  if (!value || typeof value !== 'object') return results;
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbiddenPaths(item, `${path}[${index}]`, results));
    return results;
  }
  Object.entries(value).forEach(([key, nested]) => {
    if (forbiddenKeys.has(key.toLowerCase())) results.push(`${path}.${key}`);
    findForbiddenPaths(nested, `${path}.${key}`, results);
  });
  return results;
};

const assert = (condition, message) => { if (!condition) throw new Error(message); };

const run = async () => {
  const token = await acquireToken();
  for (const period of ['7D', '30D', '90D', '12M']) {
    const dashboard = await request(`/admin/dashboard?period=${period}`, token);
    assert(dashboard.period?.key === period, `${period}: period mismatch.`);
    assert(dashboard.period?.timezone === 'Asia/Ho_Chi_Minh', `${period}: timezone mismatch.`);
    assert(dashboard.finance?.warranty_reserve_held?.availability === 'UNAVAILABLE', `${period}: Warranty Reserve must be unavailable.`);
    assert(JSON.stringify(dashboard.finance?.successful_platform_fee_in_period?.included_transaction_types) === '["PLATFORM_SERVICE_FEE"]', `${period}: platform fee types are not canonical.`);
    assert(Array.isArray(dashboard.jobs?.all_time_status_distribution), `${period}: all-time Job distribution missing.`);
    assert(Array.isArray(dashboard.jobs?.created_in_period_current_status_distribution), `${period}: period Job distribution missing.`);
    console.log(`PASS Dashboard ${period}`);
  }
  const options = await request('/admin/audit-logs/filter-options', token);
  assert(options.categories?.includes('OTHER'), 'Audit category OTHER is missing.');
  const list = await request('/admin/audit-logs?page=1&page_size=5', token);
  const forbiddenList = findForbiddenPaths(list);
  assert(!forbiddenList.length, `Audit list leaked forbidden keys: ${forbiddenList.join(', ')}`);
  if (list.items?.[0]) {
    const detail = await request(`/admin/audit-logs/${list.items[0].audit_id}`, token);
    const forbiddenDetail = findForbiddenPaths(detail);
    assert(!forbiddenDetail.length, `Audit detail leaked forbidden keys: ${forbiddenDetail.join(', ')}`);
  }
  console.log('PASS Audit list/filter-options/detail privacy smoke');
  console.log('Phase 4 read-only manual smoke completed successfully.');
};

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
