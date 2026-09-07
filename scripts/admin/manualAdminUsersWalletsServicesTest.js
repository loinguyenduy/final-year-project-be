import crypto from 'node:crypto';
import { io } from 'socket.io-client';

const environment = String(process.env.NODE_ENV || 'development').toLowerCase();
if (environment === 'production') throw new Error('This script refuses to run in production.');

const baseUrl = String(process.env.ADMIN_PHASE3_TEST_BASE_URL || 'http://localhost:5000/api/v1').replace(/\/$/, '');
const adminEmail = String(process.env.ADMIN_PHASE3_TEST_EMAIL || '').trim();
const adminPassword = String(process.env.ADMIN_PHASE3_TEST_PASSWORD || '');
const headers = (token, json = false) => ({
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  ...(json ? { 'Content-Type': 'application/json' } : {}),
  'X-Correlation-ID': crypto.randomUUID()
});
const parse = async (response) => ({ status: response.status, body: await response.json(), cookies: response.headers.getSetCookie?.() || [] });
const request = (path, options = {}) => fetch(`${baseUrl}${path}`, options).then(parse);
const assertSuccess = (result, label) => {
  if (result.status < 200 || result.status >= 300 || result.body.EC !== 0) {
    throw new Error(`${label} failed: ${result.status} ${result.body.code || result.body.EM}`);
  }
  return result;
};
const findForbiddenKeys = (value, path = '$', findings = []) => {
  if (Array.isArray(value)) value.forEach((item, index) => findForbiddenKeys(item, `${path}[${index}]`, findings));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => {
    if (['wallet_id', 'from_wallet_id', 'to_wallet_id', 'idempotency_key', 'auth_version', 'provider_payload', 'webhook_payload', 'gps_lat', 'gps_long'].includes(key)) findings.push(`${path}.${key}`);
    findForbiddenKeys(item, `${path}.${key}`, findings);
  });
  return findings;
};

if (!adminEmail || !adminPassword) {
  console.info('Phase 3 script loaded safely. Set ADMIN_PHASE3_TEST_EMAIL and ADMIN_PHASE3_TEST_PASSWORD to run read-only API checks. No data was changed.');
  process.exit(0);
}

const adminLogin = assertSuccess(await request('/auth/admin/login', {
  method: 'POST', headers: headers(null, true), body: JSON.stringify({ valueLogin: adminEmail, password: adminPassword })
}), 'Admin login');
const adminToken = adminLogin.body.DT.access_token;
const readPaths = ['/admin/users?page_size=2', '/admin/wallets?page_size=2', '/admin/transactions?page_size=2', '/admin/services?page_size=2'];
for (const path of readPaths) {
  const result = assertSuccess(await request(path, { headers: headers(adminToken) }), `Read ${path}`);
  const leaks = findForbiddenKeys(result.body.DT);
  if (leaks.length) throw new Error(`${path} exposed forbidden field(s): ${leaks.join(', ')}`);
}
console.info('Phase 3 read-only route and DTO privacy checks passed.');

const allowMutation = String(process.env.ADMIN_PHASE3_TEST_ALLOW_ACCOUNT_MUTATION || '').toLowerCase() === 'true';
if (!allowMutation) {
  console.info('Account revocation checks skipped. Set ADMIN_PHASE3_TEST_ALLOW_ACCOUNT_MUTATION=true only for a disposable participant. Wallets and Transactions are never mutated by this script.');
  process.exit(0);
}

const userId = String(process.env.ADMIN_PHASE3_TEST_USER_ID || '').trim();
const confirmedUserId = String(process.env.ADMIN_PHASE3_TEST_CONFIRM_DISPOSABLE_USER_ID || '').trim();
const participantEmail = String(process.env.ADMIN_PHASE3_TEST_PARTICIPANT_EMAIL || '').trim();
const participantPassword = String(process.env.ADMIN_PHASE3_TEST_PARTICIPANT_PASSWORD || '');
if (!/^[0-9a-f-]{36}$/i.test(userId) || confirmedUserId !== userId || !participantEmail || !participantPassword) {
  throw new Error('Mutation requires a valid matching USER_ID/CONFIRM_DISPOSABLE_USER_ID and disposable participant credentials.');
}
const detail = assertSuccess(await request(`/admin/users/${userId}`, { headers: headers(adminToken) }), 'Load disposable user');
if (!detail.body.DT.overview.is_active) throw new Error('Disposable participant must be active before this test.');

const participantLogin = assertSuccess(await request('/auth/login', {
  method: 'POST', headers: headers(null, true), body: JSON.stringify({ valueLogin: participantEmail, password: participantPassword })
}), 'Participant login A');
const tokenA = participantLogin.body.DT.access_token;
const refreshCookieA = participantLogin.cookies.map((cookie) => cookie.split(';')[0]).find((cookie) => cookie.startsWith('refreshToken='));
if (!refreshCookieA) throw new Error('Participant login A did not return the refresh cookie.');

const connectSocket = (token, expectedSuccess) => new Promise((resolve, reject) => {
  const socket = io(new URL(baseUrl).origin, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false, timeout: 5000 });
  const timer = setTimeout(() => { socket.disconnect(); reject(new Error('Socket check timed out.')); }, 6000);
  socket.on('connect', () => {
    clearTimeout(timer); socket.disconnect();
    if (!expectedSuccess) reject(new Error('Revoked token unexpectedly connected to Socket.IO.'));
    else resolve();
  });
  socket.on('connect_error', (error) => {
    clearTimeout(timer); socket.disconnect();
    if (expectedSuccess) reject(new Error(`New token Socket connection failed: ${error?.data?.code || error.message}`));
    else if (error?.data?.code !== 'SESSION_REVOKED') reject(new Error(`Expected SESSION_REVOKED, received ${error?.data?.code || error.message}`));
    else resolve();
  });
});

const openSocket = (token) => new Promise((resolve, reject) => {
  const socket = io(new URL(baseUrl).origin, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false, timeout: 5000 });
  const timer = setTimeout(() => { socket.disconnect(); reject(new Error('Initial Socket connection timed out.')); }, 6000);
  socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
  socket.once('connect_error', (error) => { clearTimeout(timer); socket.disconnect(); reject(new Error(`Token A initial Socket connection failed: ${error?.data?.code || error.message}`)); });
});

const liveSocketA = await openSocket(tokenA);
const forcedDisconnect = new Promise((resolve, reject) => {
  const timer = setTimeout(() => { liveSocketA.disconnect(); reject(new Error('Active Socket A was not disconnected after deactivation.')); }, 6000);
  liveSocketA.once('disconnect', (reason) => { clearTimeout(timer); if (reason !== 'io server disconnect') reject(new Error(`Socket A disconnected for an unexpected reason: ${reason}`)); else resolve(); });
});
let reactivated = false;
try {
  assertSuccess(await request(`/admin/users/${userId}/deactivate`, {
    method: 'POST', headers: headers(adminToken, true), body: JSON.stringify({ reason_code: 'SECURITY_RISK', reason_text: 'Disposable auth-version integration test.' })
  }), 'Deactivate participant');
  await forcedDisconnect;
  const inactiveRequest = await request('/fintech/wallets/me', { headers: headers(tokenA) });
  if (inactiveRequest.body.code !== 'ACCOUNT_INACTIVE') throw new Error(`Token A while inactive returned ${inactiveRequest.body.code}.`);
  assertSuccess(await request(`/admin/users/${userId}/reactivate`, {
    method: 'POST', headers: headers(adminToken, true), body: JSON.stringify({ reason_code: 'SECURITY_RISK', reason_text: 'Restore disposable participant after auth-version test.' })
  }), 'Reactivate participant');
  reactivated = true;
  const revokedRequest = await request('/fintech/wallets/me', { headers: headers(tokenA) });
  if (revokedRequest.body.code !== 'SESSION_REVOKED') throw new Error(`Token A after reactivate returned ${revokedRequest.body.code}.`);
  const oldRefresh = await request('/auth/refresh', { method: 'POST', headers: { ...headers(null), Cookie: refreshCookieA } });
  if (oldRefresh.body.EC === 0) throw new Error('Refresh token A unexpectedly rotated after deactivate/reactivate.');
  await connectSocket(tokenA, false);
  const loginB = assertSuccess(await request('/auth/login', {
    method: 'POST', headers: headers(null, true), body: JSON.stringify({ valueLogin: participantEmail, password: participantPassword })
  }), 'Participant login B');
  assertSuccess(await request('/fintech/wallets/me', { headers: headers(loginB.body.DT.access_token) }), 'Token B REST check');
  await connectSocket(loginB.body.DT.access_token, true);
  console.info('Phase 3 auth-version REST, refresh and Socket matrix passed.', { user_id: userId });
} finally {
  if (liveSocketA.connected) liveSocketA.disconnect();
  await forcedDisconnect.catch(() => {});
  if (!reactivated) {
    const current = await request(`/admin/users/${userId}`, { headers: headers(adminToken) });
    if (current.body.DT?.overview?.is_active === false) {
      await request(`/admin/users/${userId}/reactivate`, {
        method: 'POST', headers: headers(adminToken, true), body: JSON.stringify({ reason_code: 'OTHER', reason_text: 'Safety restoration after an interrupted disposable integration test.' })
      });
    }
  }
}
