import dotenv from 'dotenv';
import { analyzeConversation } from '../../src/modules/ai/providers/Gemini.provider.js';

dotenv.config();

const startedAt = Date.now();

try {
  const result = await analyzeConversation({
    serviceCatalog: [{ service_code: 'SMOKE_TEST_SERVICE', name: 'Smoke Test Service' }],
    structuredState: {},
    recentMessages: [],
    customerMessage: 'A test fixture is not working. Ask one short follow-up question.',
    correlationId: null,
    sessionId: null
  });
  console.log({
    status: 'OK',
    model: process.env.GEMINI_MODEL,
    stage: result.data.stage,
    latency_ms: Date.now() - startedAt
  });
} catch (error) {
  console.error({
    status: 'FAILED',
    code: error?.code || 'UNKNOWN',
    model_configured: Boolean(process.env.GEMINI_MODEL),
    api_key_configured: Boolean(process.env.GEMINI_API_KEY),
    latency_ms: Date.now() - startedAt
  });
  process.exitCode = 1;
}
