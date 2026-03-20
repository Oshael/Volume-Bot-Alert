const config = require('../../config');

const RESEND_API_URL = 'https://api.resend.com/emails';

function getEmailConfig() {
  return config.email || {};
}

function isEmailEnabled() {
  return Boolean(getEmailConfig().enabled);
}

function isSupportedProvider(provider) {
  return provider === 'resend';
}

function assertEmailReady() {
  const emailConfig = getEmailConfig();

  if (!emailConfig.enabled) {
    throw new Error('Email sending is disabled');
  }
  if (!isSupportedProvider(emailConfig.provider)) {
    throw new Error(`Unsupported email provider: ${emailConfig.provider || 'unset'}`);
  }
  if (!emailConfig.from) {
    throw new Error('EMAIL_FROM is required when email sending is enabled');
  }
  if (!emailConfig.resend?.apiKey) {
    throw new Error('RESEND_API_KEY is required when EMAIL_PROVIDER=resend');
  }
}

async function sendWithResend(message) {
  const emailConfig = getEmailConfig();
  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${emailConfig.resend.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: emailConfig.from,
      to: Array.isArray(message.to) ? message.to : [message.to],
      reply_to: message.replyTo || emailConfig.replyTo || undefined,
      subject: message.subject,
      html: message.html,
      text: message.text,
      tags: Array.isArray(message.tags) ? message.tags : undefined,
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const providerMessage = payload?.message || payload?.error || `HTTP ${response.status}`;
    throw new Error(`Resend send failed: ${providerMessage}`);
  }

  return {
    provider: 'resend',
    id: payload?.id || null,
    payload,
  };
}

async function sendEmail(message) {
  assertEmailReady();

  const to = Array.isArray(message?.to)
    ? message.to.filter(Boolean)
    : [String(message?.to || '').trim()].filter(Boolean);
  const subject = String(message?.subject || '').trim();
  const html = String(message?.html || '').trim();
  const text = String(message?.text || '').trim();

  if (to.length === 0) {
    throw new Error('Email recipient is required');
  }
  if (!subject) {
    throw new Error('Email subject is required');
  }
  if (!html && !text) {
    throw new Error('Email body is required');
  }

  const provider = getEmailConfig().provider;
  if (provider === 'resend') {
    return sendWithResend({
      ...message,
      to,
      subject,
      html,
      text,
    });
  }

  throw new Error(`Unsupported email provider: ${provider || 'unset'}`);
}

module.exports = {
  getEmailConfig,
  isEmailEnabled,
  isSupportedProvider,
  sendEmail,
};
