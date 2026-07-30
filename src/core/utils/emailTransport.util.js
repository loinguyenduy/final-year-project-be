import nodemailer from 'nodemailer';

const BREVO_SEND_EMAIL_URL = 'https://api.brevo.com/v3/smtp/email';
const EMAIL_TIMEOUT_MS = 10_000;

class EmailDeliveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EmailDeliveryError';
    this.code = code;
  }
}

const missingNames = (environment, names) => (
  names.filter((name) => !String(environment[name] || '').trim())
);

const invalidConfiguration = (names) => {
  const suffix = names.length > 0 ? `: ${names.join(', ')}` : '';
  return new EmailDeliveryError(
    'EMAIL_CONFIGURATION_INVALID',
    `Email configuration is invalid or incomplete${suffix}.`,
  );
};

const resolveEmailTransportConfig = (environment = process.env) => {
  const configuredTransport = String(environment.EMAIL_TRANSPORT || '').trim().toLowerCase();
  const transport = configuredTransport
    || (environment.NODE_ENV === 'production' ? '' : 'smtp');

  if (transport === 'smtp') {
    const required = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM'];
    const missing = missingNames(environment, required);
    if (missing.length > 0) throw invalidConfiguration(missing);
    return {
      transport,
      smtp: {
        host: environment.SMTP_HOST,
        port: Number(environment.SMTP_PORT),
        auth: {
          user: environment.SMTP_USER,
          pass: environment.SMTP_PASS,
        },
      },
      from: `"The Trusted Handyman" <${environment.EMAIL_FROM}>`,
    };
  }

  if (transport === 'brevo-api') {
    const required = ['BREVO_API_KEY', 'EMAIL_FROM_ADDRESS', 'EMAIL_FROM_NAME'];
    const missing = missingNames(environment, required);
    if (missing.length > 0) throw invalidConfiguration(missing);
    return {
      transport,
      apiKey: environment.BREVO_API_KEY,
      sender: {
        email: environment.EMAIL_FROM_ADDRESS,
        name: environment.EMAIL_FROM_NAME,
      },
    };
  }

  throw invalidConfiguration(['EMAIL_TRANSPORT']);
};

const sendWithBrevo = async ({
  config,
  message,
  fetchImpl,
  timeoutMs,
}) => {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  let response;

  try {
    response = await fetchImpl(BREVO_SEND_EMAIL_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-key': config.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender: config.sender,
        to: [{ email: message.to }],
        subject: message.subject,
        htmlContent: message.html,
      }),
      signal: abortController.signal,
    });
  } catch (error) {
    if (abortController.signal.aborted || error?.name === 'AbortError') {
      throw new EmailDeliveryError('EMAIL_PROVIDER_TIMEOUT', 'Email delivery timed out.');
    }
    throw new EmailDeliveryError('EMAIL_PROVIDER_UNAVAILABLE', 'Email delivery is unavailable.');
  } finally {
    clearTimeout(timeout);
  }

  if (response.ok) return;
  if ([401, 403].includes(response.status)) {
    throw new EmailDeliveryError('EMAIL_PROVIDER_AUTH_FAILED', 'Email provider authentication failed.');
  }
  if (response.status === 429) {
    throw new EmailDeliveryError('EMAIL_PROVIDER_RATE_LIMITED', 'Email provider rate limit reached.');
  }
  throw new EmailDeliveryError('EMAIL_PROVIDER_FAILED', 'Email provider rejected the request.');
};

const sendEmail = async (
  message,
  {
    environment = process.env,
    fetchImpl = globalThis.fetch,
    createTransport = nodemailer.createTransport,
    timeoutMs = EMAIL_TIMEOUT_MS,
  } = {},
) => {
  const config = resolveEmailTransportConfig(environment);
  if (config.transport === 'smtp') {
    try {
      const transporter = createTransport(config.smtp);
      await transporter.sendMail({
        from: config.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
      });
      return;
    } catch {
      throw new EmailDeliveryError('EMAIL_PROVIDER_UNAVAILABLE', 'Email delivery is unavailable.');
    }
  }

  if (typeof fetchImpl !== 'function') {
    throw new EmailDeliveryError('EMAIL_PROVIDER_UNAVAILABLE', 'Email delivery is unavailable.');
  }
  await sendWithBrevo({ config, message, fetchImpl, timeoutMs });
};

export {
  BREVO_SEND_EMAIL_URL,
  EMAIL_TIMEOUT_MS,
  EmailDeliveryError,
  resolveEmailTransportConfig,
  sendEmail,
};
