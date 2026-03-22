const config = require('../../config');

const RESEND_API_URL = 'https://api.resend.com/emails';
const LOCAL_DEV_PROVIDER = 'local-dev';
const SUPPORTED_PROVIDERS = new Set(['resend', 'console', 'local']);

function isDevelopmentEmailCaptureEnabled() {
  return Boolean(getEmailConfig().development?.capture);
}

function shouldFallbackToDevelopmentCapture() {
  return Boolean(getEmailConfig().development?.fallbackOnFailure);
}

function shouldExposeEmailDebug() {
  return Boolean(getEmailConfig().development?.exposeDebug);
}

function getEmailConfig() {
  return config.email || {};
}

function isEmailEnabled() {
  return Boolean(getEmailConfig().enabled);
}

function isSupportedProvider(provider) {
  return SUPPORTED_PROVIDERS.has(provider);
}

function getMessageDebug(message) {
  if (!shouldExposeEmailDebug()) {
    return null;
  }

  const debug = message?.debug;
  if (!debug || typeof debug !== 'object') {
    return null;
  }

  return {
    flow: String(debug.flow || '').trim() || null,
    actionUrl: String(debug.actionUrl || '').trim() || null,
    otpCode: String(debug.otpCode || '').trim() || null,
    expiresMinutes: Number.isFinite(Number(debug.expiresMinutes))
      ? Number(debug.expiresMinutes)
      : null,
  };
}

function validateEmailMessage(message) {
  if (!isEmailEnabled()) {
    throw new Error('Email sending is disabled');
  }

  const to = Array.isArray(message?.to)
    ? message.to.filter(Boolean).map((item) => String(item).trim()).filter(Boolean)
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

  return {
    ...message,
    to,
    subject,
    html,
    text,
  };
}

function createLocalDelivery(message, reason) {
  const emailConfig = getEmailConfig();
  const debug = getMessageDebug(message);
  const delivery = {
    provider: LOCAL_DEV_PROVIDER,
    id: `local-${Date.now()}`,
    captured: true,
    reason,
    to: message.to,
    subject: message.subject,
    from: emailConfig.from || 'Local Dev Mailbox <local-dev@localhost>',
    debug,
  };

  console.log('[email][local-dev]', {
    to: delivery.to,
    subject: delivery.subject,
    reason,
    debug,
  });

  return delivery;
}

async function sendWithResend(message) {
  const emailConfig = getEmailConfig();
  if (!emailConfig.from) {
    throw new Error('EMAIL_FROM is required when EMAIL_PROVIDER=resend');
  }
  if (!emailConfig.resend?.apiKey) {
    throw new Error('RESEND_API_KEY is required when EMAIL_PROVIDER=resend');
  }

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
    debug: getMessageDebug(message),
  };
}

async function sendEmail(message) {
  const normalizedMessage = validateEmailMessage(message);
  const provider = getEmailConfig().provider;

  if (provider === 'console' || provider === 'local') {
    return createLocalDelivery(normalizedMessage, `EMAIL_PROVIDER=${provider}`);
  }

  if (provider === 'resend') {
    try {
      return await sendWithResend(normalizedMessage);
    } catch (error) {
      if (!isDevelopmentEmailCaptureEnabled() || !shouldFallbackToDevelopmentCapture()) {
        throw error;
      }

      console.warn('[email] Falling back to local development capture:', error.message);
      return createLocalDelivery(normalizedMessage, error.message);
    }
  }

  if (isDevelopmentEmailCaptureEnabled()) {
    return createLocalDelivery(normalizedMessage, `Unsupported provider fallback: ${provider || 'unset'}`);
  }

  throw new Error(`Unsupported email provider: ${provider || 'unset'}`);
}

module.exports = {
  getEmailConfig,
  isEmailEnabled,
  isSupportedProvider,
  shouldExposeEmailDebug,
  sendEmail,
};
