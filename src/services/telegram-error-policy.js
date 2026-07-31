const DEFAULT_RETRY_DELAYS_MS = Object.freeze([
  5_000,
  15_000,
  60_000,
  5 * 60_000,
  10 * 60_000,
]);

class TelegramBotError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'TelegramBotError';
    this.code = details.code || 'telegram_error';
    this.method = details.method || null;
    this.status = details.status || null;
    this.retryable = Boolean(details.retryable);
    this.retryAfterSeconds = details.retryAfterSeconds || null;
  }
}

function redactTelegramSecrets(value, botToken = '') {
  let redacted = String(value || '');
  if (botToken) redacted = redacted.split(botToken).join('[REDACTED]');
  return redacted.replace(/\/bot[^/\s]+(?=\/)/gi, '/bot[REDACTED]');
}

function apiErrorCode(status, description) {
  const normalized = description.toLowerCase();
  if (status === 429) return 'rate_limited';
  if (status === 401) return 'invalid_token';
  if (normalized.includes('bot was blocked')) return 'bot_blocked';
  if (normalized.includes('chat not found')) return 'chat_not_found';
  if (normalized.includes('message is not modified')) return 'message_not_modified';
  if (status === 403) return 'forbidden';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'api_unavailable';
  if (status >= 400) return 'invalid_request';
  return 'invalid_response';
}

function createTelegramApiError({ method, status, payload, botToken }) {
  const description = redactTelegramSecrets(payload?.description || `HTTP ${status}`, botToken);
  const retryAfterSeconds = Number(payload?.parameters?.retry_after);
  const retryable = status === 408 || status === 429 || status >= 500;
  return new TelegramBotError(`Telegram ${method} failed: ${description}`, {
    code: apiErrorCode(status, description),
    method,
    status,
    retryable,
    retryAfterSeconds: Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds
      : null,
  });
}

function createTelegramTransportError(error, { method, botToken, timedOut = false, aborted = false }) {
  const code = timedOut ? 'timeout' : aborted ? 'aborted' : 'transport_error';
  const detail = redactTelegramSecrets(error?.message || code, botToken);
  return new TelegramBotError(`Telegram ${method} failed: ${detail}`, {
    code,
    method,
    retryable: !aborted,
  });
}

function positiveInteger(value, field) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return normalized;
}

function normalizeDeliveryError(error) {
  const code = String(error?.code || error?.name || 'delivery_error')
    .trim()
    .slice(0, 64) || 'delivery_error';
  const message = redactTelegramSecrets(error?.message || error || code)
    .trim()
    .slice(0, 2000) || code;
  return { code, message };
}

function decideTelegramDeliveryFailure(input = {}) {
  const attempts = positiveInteger(input.attempts, 'delivery attempts');
  const maxAttempts = positiveInteger(input.maxAttempts, 'maximum delivery attempts');
  const nowMs = Number(input.nowMs ?? Date.now());
  if (!Number.isFinite(nowMs)) {
    throw new TypeError('delivery failure nowMs must be finite');
  }
  const error = normalizeDeliveryError(input.error);
  if (input.error?.retryable !== true) {
    return Object.freeze({
      status: 'failed',
      errorCode: error.code,
      error: error.message,
      nextAttemptAt: null,
      delayMs: null,
    });
  }
  if (attempts >= maxAttempts) {
    return Object.freeze({
      status: 'failed',
      errorCode: 'attempts_exhausted',
      error: error.message,
      nextAttemptAt: null,
      delayMs: null,
    });
  }

  const fallbackDelay = DEFAULT_RETRY_DELAYS_MS[
    Math.min(attempts - 1, DEFAULT_RETRY_DELAYS_MS.length - 1)
  ];
  const retryAfterSeconds = Number(input.error?.retryAfterSeconds);
  const retryAfterMs = Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds > 0
    ? retryAfterSeconds * 1000
    : 0;
  const delayMs = Math.max(fallbackDelay, retryAfterMs);
  return Object.freeze({
    status: 'retry',
    errorCode: error.code,
    error: error.message,
    nextAttemptAt: new Date(nowMs + delayMs).toISOString(),
    delayMs,
  });
}

module.exports = {
  DEFAULT_RETRY_DELAYS_MS,
  TelegramBotError,
  createTelegramApiError,
  createTelegramTransportError,
  decideTelegramDeliveryFailure,
  redactTelegramSecrets,
};
