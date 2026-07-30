import crypto from 'node:crypto';
import { calculateCancellationDistribution } from '../../src/modules/matchmaking/utils/cancellationPolicy.util.js';

const environment = String(process.env.NODE_ENV || 'development').toLowerCase();
if (environment === 'production') throw new Error('This script refuses to run in production.');

const expectedMatrix = {
  EN_ROUTE: { CUSTOMER_FAULT: [50, 50], HANDYMAN_FAULT: [100, 0], NEUTRAL: [100, 0] },
  ARRIVED: { CUSTOMER_FAULT: [30, 70], HANDYMAN_FAULT: [100, 0], NEUTRAL: [50, 50] },
  QUOTE_PENDING: { CUSTOMER_FAULT: [30, 70], HANDYMAN_FAULT: [100, 0], NEUTRAL: [50, 50] },
  PAYMENT_PENDING: { CUSTOMER_FAULT: [30, 70], HANDYMAN_FAULT: [100, 0], NEUTRAL: [50, 50] }
};
for (const [phase, classifications] of Object.entries(expectedMatrix)) {
  for (const [classification, [customerPercent, handymanPercent]] of Object.entries(classifications)) {
    const distribution = calculateCancellationDistribution({ depositAmount: 10000n, phase, classification });
    if (!distribution.valid
        || distribution.customerAmount !== BigInt(customerPercent * 100)
        || distribution.handymanAmount !== BigInt(handymanPercent * 100)
        || distribution.platformAmount !== 0n) {
      throw new Error(`Cancellation matrix mismatch for ${phase}/${classification}.`);
    }
  }
}

const baseUrl = String(process.env.ADMIN_REVIEW_TEST_BASE_URL || 'http://localhost:5000/api/v1').replace(/\/$/, '');
const email = String(process.env.ADMIN_REVIEW_TEST_EMAIL || '').trim();
const password = String(process.env.ADMIN_REVIEW_TEST_PASSWORD || '');
if (!email || !password) {
  console.info('Cancellation policy matrix passed. API checks were skipped. Set ADMIN_REVIEW_TEST_EMAIL and ADMIN_REVIEW_TEST_PASSWORD to continue.');
  process.exit(0);
}

const parseResponse = async (response) => ({ status: response.status, body: await response.json() });
const login = await fetch(`${baseUrl}/auth/admin/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Correlation-ID': crypto.randomUUID() },
  body: JSON.stringify({ valueLogin: email, password })
}).then(parseResponse);
if (login.status !== 200 || login.body.EC !== 0) throw new Error(`Admin login failed: ${login.body.code || login.body.EM}`);
const headers = { Authorization: `Bearer ${login.body.DT.access_token}` };

const counts = await fetch(`${baseUrl}/admin/queue-counts`, { headers }).then(parseResponse);
const list = await fetch(`${baseUrl}/admin/reviews?status=PENDING&page_size=20`, { headers }).then(parseResponse);
if (counts.status !== 200 || list.status !== 200) throw new Error('Review queue read check failed.');
const cases = list.body.DT?.items || [];
if (cases.some((item) => JSON.stringify(item).match(/media_url|cloudinary|gps_lat|gps_long|wallet_id/i))) {
  throw new Error('Review queue leaked a forbidden sensitive field.');
}
console.info('Review Center read checks passed.', {
  counts: counts.body.DT,
  pending_items_returned: cases.length,
  next_cursor_available: Boolean(list.body.DT?.pagination?.next_cursor)
});

const allowMutation = String(process.env.ADMIN_REVIEW_TEST_ALLOW_DB_MUTATION || '').toLowerCase() === 'true';
if (!allowMutation) {
  console.info('Mutation checks skipped. The script never creates or adjusts Wallet data. To test a prepared canonical case, set ADMIN_REVIEW_TEST_ALLOW_DB_MUTATION=true plus ADMIN_REVIEW_TEST_CASE_TYPE, ADMIN_REVIEW_TEST_CASE_ID, ADMIN_REVIEW_TEST_DECISION and reason variables.');
  process.exit(0);
}

const caseType = String(process.env.ADMIN_REVIEW_TEST_CASE_TYPE || '').trim().toUpperCase();
const caseId = String(process.env.ADMIN_REVIEW_TEST_CASE_ID || '').trim();
const decision = String(process.env.ADMIN_REVIEW_TEST_DECISION || '').trim().toUpperCase();
const reasonCode = String(process.env.ADMIN_REVIEW_TEST_REASON_CODE || '').trim().toUpperCase();
const reasonText = String(process.env.ADMIN_REVIEW_TEST_REASON_TEXT || '').trim();
if (!['WARRANTY_CLAIM', 'WARRANTY_REWORK', 'CANCELLATION'].includes(caseType)
    || !/^[0-9a-f-]{36}$/i.test(caseId) || !decision || !reasonCode) {
  throw new Error('A complete prepared case identity and decision are required. This script refuses to synthesize financial fixtures or edit Wallet balances. See docs/manual-admin-review-center-test.md.');
}
const pathByType = {
  WARRANTY_CLAIM: 'warranty-claims',
  WARRANTY_REWORK: 'warranty-reworks',
  CANCELLATION: 'cancellations'
};
const key = crypto.randomUUID();
const body = { decision, reason_code: reasonCode, reason_text: reasonText || null, idempotency_key: key };
const decide = () => fetch(`${baseUrl}/admin/reviews/${pathByType[caseType]}/${caseId}/decision`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json', 'X-Correlation-ID': crypto.randomUUID() },
  body: JSON.stringify(body)
}).then(parseResponse);
const first = await decide();
const replay = await decide();
if (first.status !== 200 || replay.status !== 200 || replay.body.code !== 'ADMIN_DECISION_REPLAYED') {
  throw new Error(`Decision/replay check failed: ${JSON.stringify({ first, replay })}`);
}
const detail = await fetch(`${baseUrl}/admin/reviews/${caseType}/${caseId}`, { headers }).then(parseResponse);
if (detail.status !== 200 || detail.body.DT?.allowed_actions?.length) {
  throw new Error('Canonical detail did not reflect the terminal/non-actionable decision state.');
}
console.info('Admin Review mutation and idempotent replay passed.', {
  case_type: caseType,
  case_id: caseId,
  decision,
  audit_id: first.body.DT.audit_id
});
console.info('No automatic cleanup is performed because business and financial decisions are immutable. Use a disposable development fixture/database.');
