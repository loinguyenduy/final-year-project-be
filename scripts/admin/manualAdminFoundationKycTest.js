import crypto from 'crypto';

const environment = String(process.env.NODE_ENV || 'development').toLowerCase();
if (environment === 'production') throw new Error('This script cannot run in production.');
if (String(process.env.ADMIN_KYC_TEST_ALLOW_DB_MUTATION || '').toLowerCase() !== 'true') {
  throw new Error('Set ADMIN_KYC_TEST_ALLOW_DB_MUTATION=true to run this mutating manual test.');
}

const baseUrl = String(process.env.ADMIN_TEST_BASE_URL || 'http://localhost:5000/api/v1').replace(/\/$/, '');
const email = String(process.env.ADMIN_TEST_EMAIL || '').trim();
const password = String(process.env.ADMIN_TEST_PASSWORD || '');
if (!email || !password) throw new Error('ADMIN_TEST_EMAIL and ADMIN_TEST_PASSWORD are required.');

const parseResponse = async (response) => ({
  status: response.status,
  body: await response.json()
});

const loginResponse = await fetch(`${baseUrl}/auth/admin/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Correlation-ID': crypto.randomUUID() },
  body: JSON.stringify({ valueLogin: email, password })
});
const login = await parseResponse(loginResponse);
if (login.status !== 200 || login.body.EC !== 0) {
  throw new Error(`Admin login failed: ${login.status} ${login.body.code || login.body.EM}`);
}
const token = login.body.DT.access_token;
const authHeaders = { Authorization: `Bearer ${token}` };

let submissionId = String(process.env.ADMIN_TEST_SUBMISSION_ID || '').trim();
if (!submissionId) {
  const listResponse = await fetch(`${baseUrl}/admin/kyc/requests?status=PENDING&page_size=1`, { headers: authHeaders });
  const list = await parseResponse(listResponse);
  submissionId = list.body.DT?.items?.[0]?.id;
}
if (!submissionId) throw new Error('No pending non-legacy KYC submission is available for the concurrency test.');

const decision = String(process.env.ADMIN_TEST_DECISION || 'APPROVE').toUpperCase();
const payload = decision === 'REJECT'
  ? { decision, reason_code: 'DOCUMENT_UNCLEAR', reason_text: 'Manual concurrency test rejection.' }
  : { decision: 'APPROVE' };

const decide = () => fetch(`${baseUrl}/admin/kyc/requests/${submissionId}/decision`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json', 'X-Correlation-ID': crypto.randomUUID() },
  body: JSON.stringify(payload)
}).then(parseResponse);

const results = await Promise.all([decide(), decide()]);
const successes = results.filter((result) => result.status === 200 && result.body.EC === 0);
const conflicts = results.filter((result) => (
  result.status === 409 && result.body.code === 'KYC_REQUEST_ALREADY_REVIEWED'
));
if (successes.length !== 1 || conflicts.length !== 1) {
  throw new Error(`Expected one success and one conflict, received: ${JSON.stringify(results)}`);
}

const auditResponse = await fetch(
  `${baseUrl}/admin/audit-logs?target_type=KYC_SUBMISSION&target_id=${encodeURIComponent(submissionId)}&page_size=10`,
  { headers: authHeaders }
);
const audit = await parseResponse(auditResponse);
const matchingAudits = audit.body.DT?.items?.filter((item) => (
  item.target_id === submissionId && ['ADMIN_KYC_APPROVED', 'ADMIN_KYC_REJECTED'].includes(item.action)
)) || [];
if (matchingAudits.length !== 1) {
  throw new Error(`Expected exactly one KYC decision audit record, received ${matchingAudits.length}.`);
}

console.info('Admin KYC concurrency test passed.', {
  submission_id: submissionId,
  success_code: successes[0].body.code,
  conflict_code: conflicts[0].body.code,
  audit_id: matchingAudits[0].id
});
