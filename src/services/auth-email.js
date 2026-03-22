const config = require('../../config');
const emailService = require('./email-service');

function getAppBaseUrl() {
  return String(config.email?.appBaseUrl || '').replace(/\/+$/, '');
}

function buildUrl(path, params = {}) {
  const baseUrl = getAppBaseUrl();
  if (!baseUrl) {
    throw new Error('APP_BASE_URL is required for auth email links');
  }

  const url = new URL(path, `${baseUrl}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function buildPasswordResetEmail({ username, resetUrl, expiresMinutes }) {
  const safeName = String(username || 'there').trim() || 'there';
  const text = [
    `Hi ${safeName},`,
    '',
    'We received a request to reset your TrendScope password.',
    `Reset your password: ${resetUrl}`,
    '',
    `This link expires in ${expiresMinutes} minute(s).`,
    'If you did not request this reset, you can ignore this email.',
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#f4f4f4;background:#101314;padding:24px;">
      <div style="max-width:560px;margin:0 auto;background:#171b1d;border:1px solid #2a3136;border-radius:14px;padding:24px;">
        <h2 style="margin:0 0 12px;color:#ffffff;">TrendScope password reset</h2>
        <p style="margin:0 0 12px;">Hi ${safeName},</p>
        <p style="margin:0 0 18px;">We received a request to reset your password.</p>
        <p style="margin:0 0 18px;">
          <a href="${resetUrl}" style="display:inline-block;padding:12px 18px;background:#f4f4f4;color:#101314;text-decoration:none;border-radius:10px;font-weight:700;">Reset password</a>
        </p>
        <p style="margin:0 0 10px;">This link expires in ${expiresMinutes} minute(s).</p>
        <p style="margin:0;color:#b8c0c4;">If you did not request this reset, you can ignore this email.</p>
      </div>
    </div>
  `.trim();

  return {
    subject: 'Reset your TrendScope password',
    text,
    html,
  };
}

function buildEmailVerificationEmail({ username, verificationUrl, expiresMinutes }) {
  const safeName = String(username || 'there').trim() || 'there';
  const text = [
    `Hi ${safeName},`,
    '',
    'Please verify your email for TrendScope.',
    `Verify email: ${verificationUrl}`,
    '',
    `This link expires in ${expiresMinutes} minute(s).`,
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#f4f4f4;background:#101314;padding:24px;">
      <div style="max-width:560px;margin:0 auto;background:#171b1d;border:1px solid #2a3136;border-radius:14px;padding:24px;">
        <h2 style="margin:0 0 12px;color:#ffffff;">Verify your TrendScope email</h2>
        <p style="margin:0 0 12px;">Hi ${safeName},</p>
        <p style="margin:0 0 18px;">Please verify your email to finish setting up your account.</p>
        <p style="margin:0 0 18px;">
          <a href="${verificationUrl}" style="display:inline-block;padding:12px 18px;background:#f4f4f4;color:#101314;text-decoration:none;border-radius:10px;font-weight:700;">Verify email</a>
        </p>
        <p style="margin:0;color:#b8c0c4;">This link expires in ${expiresMinutes} minute(s).</p>
      </div>
    </div>
  `.trim();

  return {
    subject: 'Verify your TrendScope email',
    text,
    html,
  };
}

function buildPasswordChangedEmail({ username, loginUrl }) {
  const safeName = String(username || 'there').trim() || 'there';
  const text = [
    `Hi ${safeName},`,
    '',
    'Your TrendScope password was changed successfully.',
    'If this was you, no action is needed.',
    `If this was not you, open the app immediately and start a password reset: ${loginUrl}`,
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#f4f4f4;background:#101314;padding:24px;">
      <div style="max-width:560px;margin:0 auto;background:#171b1d;border:1px solid #2a3136;border-radius:14px;padding:24px;">
        <h2 style="margin:0 0 12px;color:#ffffff;">TrendScope password changed</h2>
        <p style="margin:0 0 12px;">Hi ${safeName},</p>
        <p style="margin:0 0 12px;">Your password was changed successfully.</p>
        <p style="margin:0 0 18px;">If this was not you, use the app immediately to reset your password again and secure the account.</p>
        <p style="margin:0;">
          <a href="${loginUrl}" style="display:inline-block;padding:12px 18px;background:#f4f4f4;color:#101314;text-decoration:none;border-radius:10px;font-weight:700;">Open TrendScope</a>
        </p>
      </div>
    </div>
  `.trim();

  return {
    subject: 'Your TrendScope password was changed',
    text,
    html,
  };
}

function buildLoginOtpEmail({ username, code, expiresMinutes }) {
  const safeName = String(username || 'there').trim() || 'there';
  const safeCode = String(code || '').trim();
  const text = [
    `Hi ${safeName},`,
    '',
    'Use this TrendScope verification code to finish signing in:',
    safeCode,
    '',
    `This code expires in ${expiresMinutes} minute(s).`,
    'If this was not you, you can ignore this email and reset your password if needed.',
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#f4f4f4;background:#101314;padding:24px;">
      <div style="max-width:560px;margin:0 auto;background:#171b1d;border:1px solid #2a3136;border-radius:14px;padding:24px;">
        <h2 style="margin:0 0 12px;color:#ffffff;">TrendScope sign-in verification</h2>
        <p style="margin:0 0 12px;">Hi ${safeName},</p>
        <p style="margin:0 0 12px;">Use this code to finish signing in:</p>
        <div style="margin:0 0 18px;padding:14px 16px;background:#101314;border:1px solid #2a3136;border-radius:12px;font-size:28px;letter-spacing:8px;font-weight:700;text-align:center;color:#ffffff;">
          ${safeCode}
        </div>
        <p style="margin:0 0 10px;">This code expires in ${expiresMinutes} minute(s).</p>
        <p style="margin:0;color:#b8c0c4;">If this was not you, ignore this email and reset your password if needed.</p>
      </div>
    </div>
  `.trim();

  return {
    subject: 'Your TrendScope verification code',
    text,
    html,
  };
}

async function sendPasswordResetEmail({ to, username, token, expiresMinutes = 30 }) {
  const resetUrl = buildUrl('/', { mode: 'reset-password', token });
  const payload = buildPasswordResetEmail({ username, resetUrl, expiresMinutes });
  return emailService.sendEmail({
    to,
    ...payload,
    tags: [{ name: 'flow', value: 'password-reset' }],
    debug: {
      flow: 'password-reset',
      actionUrl: resetUrl,
      expiresMinutes,
    },
  });
}

async function sendEmailVerificationEmail({ to, username, token, expiresMinutes = 60 }) {
  const verificationUrl = buildUrl('/', { mode: 'verify-email', token });
  const payload = buildEmailVerificationEmail({ username, verificationUrl, expiresMinutes });
  return emailService.sendEmail({
    to,
    ...payload,
    tags: [{ name: 'flow', value: 'email-verification' }],
    debug: {
      flow: 'email-verification',
      actionUrl: verificationUrl,
      expiresMinutes,
    },
  });
}

async function sendPasswordChangedEmail({ to, username }) {
  const loginUrl = buildUrl('/', {});
  const payload = buildPasswordChangedEmail({ username, loginUrl });
  return emailService.sendEmail({
    to,
    ...payload,
    tags: [{ name: 'flow', value: 'password-changed' }],
  });
}

async function sendLoginOtpEmail({ to, username, code, expiresMinutes = 10 }) {
  const payload = buildLoginOtpEmail({ username, code, expiresMinutes });
  return emailService.sendEmail({
    to,
    ...payload,
    tags: [{ name: 'flow', value: 'login-otp' }],
    debug: {
      flow: 'login-otp',
      otpCode: code,
      expiresMinutes,
    },
  });
}

module.exports = {
  getAppBaseUrl,
  buildUrl,
  buildPasswordResetEmail,
  buildEmailVerificationEmail,
  buildPasswordChangedEmail,
  buildLoginOtpEmail,
  sendPasswordResetEmail,
  sendEmailVerificationEmail,
  sendPasswordChangedEmail,
  sendLoginOtpEmail,
};
