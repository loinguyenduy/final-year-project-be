import { buildFrontendUrl } from '../config/publicUrls.config.js';
import { sendEmail } from './emailTransport.util.js';

const escapeHtml = (value) => String(value || '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

const sendVerificationEmail = async (toEmail, fullName, verifyToken) => {
  const verificationLink = buildFrontendUrl('/verify-email', { token: verifyToken });
  await sendEmail({
    to: toEmail,
    subject: 'Action Required: Verify Your Email Address',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
        <h2 style="color: #2b6cb0; text-align: center;">Welcome to The Trusted Handyman!</h2>
        <p>Hi <strong>${escapeHtml(fullName)}</strong>,</p>
        <p>Thank you for registering. To complete your setup and ensure the security of your account, please verify your email address by clicking the button below:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${verificationLink}" style="background-color: #2b6cb0; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold;">Verify My Email</a>
        </div>
        <p>Or copy and paste this link into your browser:</p>
        <p style="word-break: break-all; color: #718096; font-size: 14px;">${verificationLink}</p>
        <p><em>This link will expire in 15 minutes.</em></p>
        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="font-size: 12px; color: #a0aec0; text-align: center;">If you did not request this, please ignore this email.</p>
      </div>
    `,
  });
};

const sendPasswordActionEmail = async ({
  toEmail,
  fullName,
  rawToken,
  purpose,
  expiresInMinutes,
}) => {
  const isSet = purpose === 'SET_PASSWORD';
  const path = isSet ? '/set-password' : '/reset-password';
  const action = isSet ? 'Set Password' : 'Reset Password';
  const link = `${buildFrontendUrl(path)}#token=${encodeURIComponent(rawToken)}`;
  await sendEmail({
    to: toEmail,
    subject: `${action} for your account`,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px">
      <h2>${action}</h2><p>Hi <strong>${escapeHtml(fullName)}</strong>,</p>
      <p>Use the secure button below to ${action.toLowerCase()}. The link expires in ${expiresInMinutes} minutes and can be used once.</p>
      <p style="margin:28px 0"><a href="${link}" style="background:#f97316;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">${action}</a></p>
      <p>If you did not request this action, you can ignore this email.</p>
    </div>`,
  });
};

const sendPasswordChangedEmail = async ({ toEmail, fullName }) => sendEmail({
  to: toEmail,
  subject: 'Your password was changed',
  html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px">
    <h2>Password changed</h2><p>Hi <strong>${escapeHtml(fullName)}</strong>,</p>
    <p>Your password was changed successfully and existing sessions were signed out.</p>
    <p>If this was not you, contact support immediately.</p>
  </div>`,
});

export { sendPasswordActionEmail, sendPasswordChangedEmail, sendVerificationEmail };
