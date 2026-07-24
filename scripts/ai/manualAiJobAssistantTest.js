import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import {
  buildCurrentTokenComponents,
  scoreHistoricalDescription
} from '../../src/modules/ai/utils/historicalSimilarity.util.js';
import { buildHistoricalEstimate } from '../../src/modules/ai/utils/vndEstimator.util.js';

dotenv.config();

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const runPureChecks = () => {
  const components = buildCurrentTokenComponents({
    issueDescription: 'Kitchen sink pipe leaks under the cabinet.',
    problemSummary: 'Water leaks from the sink pipe.',
    keywords: ['sink', 'pipe'],
    symptoms: ['water leak', 'sink leak']
  });
  assert(!components.descriptionTokens.has('sink'), 'Description double-counted a keyword.');
  assert(!components.symptomTokens.has('sink'), 'Symptom double-counted a keyword.');
  const score = scoreHistoricalDescription(
    components,
    'Repair a leaking sink pipe below a kitchen cabinet.'
  );
  assert(Number.isInteger(score) && score > 0 && score <= 10000, 'Similarity score invalid.');

  const insufficient = buildHistoricalEstimate({
    amounts: ['100000', '200000'],
    candidateCount: 2,
    minimumSamples: 3,
    estimatorVersion: 'manual-test'
  });
  assert(insufficient.confidence === 'INSUFFICIENT_DATA', 'Insufficient result invalid.');
  assert(insufficient.suggested_min_amount === null, 'Insufficient result invented a price.');

  const enough = buildHistoricalEstimate({
    amounts: ['100000', '110000', '120000', '130000', '140000', '150000'],
    candidateCount: 6,
    minimumSamples: 3,
    estimatorVersion: 'manual-test'
  });
  assert(enough.confidence === 'MEDIUM', 'Expected MEDIUM confidence.');
  assert(enough.suggested_typical_amount === '130000', 'Even median/rounding invalid.');
  console.log({
    check: 'pure_similarity_estimator',
    status: 'PASS',
    similarity_score: score,
    confidence: enough.confidence
  });
};

const request = async (baseUrl, token, path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {})
    }
  });
  const payload = await response.json();
  console.log({
    request: `${options.method || 'GET'} ${path}`,
    http_status: response.status,
    code: payload.code || null,
    session_status: payload.DT?.status || null,
    session_stage: payload.DT?.stage || null
  });
  return { response, payload };
};

runPureChecks();

if (process.env.NODE_ENV === 'production') {
  throw new Error('AI manual mutation test is disabled in production.');
}

const token = String(process.env.AI_TEST_CUSTOMER_TOKEN || '').trim();
const allowMutation = String(process.env.AI_TEST_ALLOW_SESSION_MUTATION || '').toLowerCase() === 'true';
if (!token || !allowMutation) {
  console.log({
    check: 'api_flow',
    status: 'SKIPPED',
    reason: 'Set AI_TEST_CUSTOMER_TOKEN and AI_TEST_ALLOW_SESSION_MUTATION=true.'
  });
  process.exit(0);
}

const baseUrl = String(process.env.AI_TEST_BASE_URL || 'http://localhost:8080/api/v1')
  .replace(/\/$/, '');
const created = await request(baseUrl, token, '/ai/job-assistant/sessions', {
  method: 'POST',
  body: JSON.stringify({})
});
assert(created.response.ok, 'Session creation failed.');
let session = created.payload.DT;

let messages = [];
if (process.env.AI_TEST_MESSAGES_JSON) {
  const parsed = JSON.parse(process.env.AI_TEST_MESSAGES_JSON);
  assert(Array.isArray(parsed), 'AI_TEST_MESSAGES_JSON must be an array.');
  messages = parsed;
} else if (process.env.AI_TEST_MESSAGE) {
  messages = [process.env.AI_TEST_MESSAGE];
}

for (const message of messages) {
  const sent = await request(
    baseUrl,
    token,
    `/ai/job-assistant/sessions/${session.session_id}/messages`,
    {
      method: 'POST',
      body: JSON.stringify({
        message,
        client_message_id: randomUUID(),
        expected_revision: session.revision
      })
    }
  );
  if (!sent.response.ok) break;
  session = sent.payload.DT;
  if (session.status === 'ESTIMATE_PRESENTED') break;
}

if (session.status === 'ESTIMATE_PRESENTED') {
  const decisionAction = process.env.AI_TEST_PRICE_DECISION
    || 'CONTINUE_WITHOUT_ESTIMATE';
  const body = {
    action: decisionAction,
    expected_revision: session.revision
  };
  if (decisionAction === 'USE_OWN_BUDGET') {
    body.budget_min = process.env.AI_TEST_BUDGET_MIN;
    body.budget_max = process.env.AI_TEST_BUDGET_MAX;
  }
  const decided = await request(
    baseUrl,
    token,
    `/ai/job-assistant/sessions/${session.session_id}/price-decision`,
    { method: 'POST', body: JSON.stringify(body) }
  );
  if (decided.response.ok) session = decided.payload.DT;
}

const allowDisposableJob = String(
  process.env.AI_TEST_ALLOW_DISPOSABLE_JOB || ''
).toLowerCase() === 'true';
if (allowDisposableJob && session.status === 'DRAFT_READY') {
  assert(process.env.AI_TEST_JOB_PAYLOAD_JSON, 'AI_TEST_JOB_PAYLOAD_JSON is required.');
  const jobPayload = JSON.parse(process.env.AI_TEST_JOB_PAYLOAD_JSON);
  const form = new FormData();
  Object.entries(jobPayload).forEach(([key, value]) => {
    if (value !== undefined && value !== null) form.append(key, String(value));
  });
  form.append('ai_assistant_session_id', session.session_id);
  const jobResult = await request(baseUrl, token, '/matchmaking/jobs', {
    method: 'POST',
    body: form
  });
  assert(jobResult.response.ok, 'Disposable AI-assisted Job creation failed.');
  console.log({
    check: 'disposable_job',
    status: 'CREATED',
    job_id: jobResult.payload.DT?.id || null,
    cleanup: 'Cancel through the canonical pre-acceptance cancellation endpoint.'
  });
} else if (String(process.env.AI_TEST_ABANDON_AFTER || 'true').toLowerCase() === 'true'
  && !['ABANDONED', 'APPLIED_TO_JOB', 'EXPIRED'].includes(session.status)) {
  await request(
    baseUrl,
    token,
    `/ai/job-assistant/sessions/${session.session_id}/abandon`,
    {
      method: 'POST',
      body: JSON.stringify({ expected_revision: session.revision })
    }
  );
}
