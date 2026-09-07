import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BREVO_SEND_EMAIL_URL,
  EmailDeliveryError,
  resolveEmailTransportConfig,
  sendEmail,
} from '../src/core/utils/emailTransport.util.js';

const brevoEnvironment = {
  NODE_ENV: 'production',
  EMAIL_TRANSPORT: 'brevo-api',
  BREVO_API_KEY: 'synthetic-test-key',
  EMAIL_FROM_ADDRESS: 'sender@example.test',
  EMAIL_FROM_NAME: 'Test Sender',
};

const message = {
  to: 'recipient@example.test',
  subject: 'Test subject',
  html: '<p>Test content</p>',
};

test('Brevo request maps URL, headers, and JSON body without putting the key in the payload', async () => {
  let captured;
  await sendEmail(message, {
    environment: brevoEnvironment,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return { ok: true, status: 201 };
    },
  });

  assert.equal(captured.url, BREVO_SEND_EMAIL_URL);
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers['api-key'], brevoEnvironment.BREVO_API_KEY);
  assert.deepEqual(JSON.parse(captured.options.body), {
    sender: {
      email: brevoEnvironment.EMAIL_FROM_ADDRESS,
      name: brevoEnvironment.EMAIL_FROM_NAME,
    },
    to: [{ email: message.to }],
    subject: message.subject,
    htmlContent: message.html,
  });
  assert.equal(captured.options.body.includes(brevoEnvironment.BREVO_API_KEY), false);
});

for (const [status, expectedCode] of [
  [401, 'EMAIL_PROVIDER_AUTH_FAILED'],
  [403, 'EMAIL_PROVIDER_AUTH_FAILED'],
  [429, 'EMAIL_PROVIDER_RATE_LIMITED'],
  [500, 'EMAIL_PROVIDER_FAILED'],
]) {
  test(`Brevo HTTP ${status} maps to ${expectedCode}`, async () => {
    await assert.rejects(
      sendEmail(message, {
        environment: brevoEnvironment,
        fetchImpl: async () => ({ ok: false, status }),
      }),
      (error) => (
        error instanceof EmailDeliveryError
        && error.code === expectedCode
        && !error.message.includes(brevoEnvironment.BREVO_API_KEY)
      ),
    );
  });
}

test('Brevo network failure maps to EMAIL_PROVIDER_UNAVAILABLE', async () => {
  await assert.rejects(
    sendEmail(message, {
      environment: brevoEnvironment,
      fetchImpl: async () => {
        throw new Error('synthetic network failure');
      },
    }),
    { code: 'EMAIL_PROVIDER_UNAVAILABLE' },
  );
});

test('Brevo timeout aborts the request and maps to EMAIL_PROVIDER_TIMEOUT', async () => {
  await assert.rejects(
    sendEmail(message, {
      environment: brevoEnvironment,
      timeoutMs: 5,
      fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
    }),
    { code: 'EMAIL_PROVIDER_TIMEOUT' },
  );
});

test('SMTP and Brevo validation are conditional', () => {
  const smtp = resolveEmailTransportConfig({
    NODE_ENV: 'development',
    EMAIL_TRANSPORT: 'smtp',
    SMTP_HOST: 'smtp.example.test',
    SMTP_PORT: '2525',
    SMTP_USER: 'synthetic-user',
    SMTP_PASS: 'synthetic-password',
    EMAIL_FROM: 'sender@example.test',
  });
  assert.equal(smtp.transport, 'smtp');

  assert.throws(
    () => resolveEmailTransportConfig({
      ...brevoEnvironment,
      BREVO_API_KEY: '',
      SMTP_HOST: 'not-required.example.test',
    }),
    (error) => (
      error.code === 'EMAIL_CONFIGURATION_INVALID'
      && error.message.includes('BREVO_API_KEY')
      && !error.message.includes('SMTP_PASS')
    ),
  );
});

test('unknown transports are rejected without including their value', () => {
  const unknownValue = 'synthetic-unknown-transport';
  assert.throws(
    () => resolveEmailTransportConfig({
      NODE_ENV: 'production',
      EMAIL_TRANSPORT: unknownValue,
    }),
    (error) => (
      error.code === 'EMAIL_CONFIGURATION_INVALID'
      && error.message.includes('EMAIL_TRANSPORT')
      && !error.message.includes(unknownValue)
    ),
  );
});
