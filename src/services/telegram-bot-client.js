const config = require('../../config');
const {
  TelegramBotError,
  createTelegramApiError,
  createTelegramTransportError,
} = require('./telegram-error-policy');

const DEFAULT_API_BASE_URL = 'https://api.telegram.org';

function requireValue(value, field) {
  if (value === undefined || value === null || value === '') {
    throw new TelegramBotError(`Telegram ${field} is required`, {
      code: 'invalid_request',
      retryable: false,
    });
  }
}

function appendFormValue(form, key, value) {
  if (value === undefined || value === null) return;
  form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
}

function createMultipartBody(payload, FormDataImpl, BlobImpl) {
  const form = new FormDataImpl();
  for (const [key, value] of Object.entries(payload)) {
    if (key !== 'photo') appendFormValue(form, key, value);
  }
  const photo = payload.photo;
  const bytes = Buffer.isBuffer(photo) || photo instanceof Uint8Array ? photo : photo?.data;
  requireValue(bytes, 'photo');
  const type = photo?.contentType || 'image/png';
  const filename = photo?.filename || 'sparkline.png';
  form.append('photo', new BlobImpl([bytes], { type }), filename);
  return form;
}

function createAbortContext(timeoutMs, upstreamSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) abort();
  else upstreamSignal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    wasTimedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      upstreamSignal?.removeEventListener('abort', abort);
    },
  };
}

function createTelegramBotClient(options = {}) {
  const settings = options.settings || config.telegram || {};
  const botToken = String(options.botToken || settings.botToken || '').trim();
  const enabled = options.enabled ?? settings.enabled;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const FormDataImpl = options.FormDataImpl || globalThis.FormData;
  const BlobImpl = options.BlobImpl || globalThis.Blob;
  const timeoutMs = options.timeoutMs || settings.deliveryTimeoutMs || 10_000;
  const apiBaseUrl = String(options.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, '');

  requireValue(botToken, 'bot token');
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');

  async function request(method, payload = {}, requestOptions = {}) {
    if (enabled === false) {
      throw new TelegramBotError('Telegram alerts are disabled', {
        code: 'disabled',
        method,
        retryable: false,
      });
    }

    const abortContext = createAbortContext(timeoutMs, requestOptions.signal);
    const url = `${apiBaseUrl}/bot${botToken}/${method}`;
    const multipart = requestOptions.multipart;
    const body = multipart
      ? createMultipartBody(payload, FormDataImpl, BlobImpl)
      : JSON.stringify(payload);
    const headers = multipart ? undefined : { 'Content-Type': 'application/json' };

    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: abortContext.signal,
      });
      const responsePayload = await response.json().catch(() => null);
      if (!response.ok || responsePayload?.ok !== true) {
        throw createTelegramApiError({
          method,
          status: responsePayload?.error_code || response.status,
          payload: responsePayload,
          botToken,
        });
      }
      return responsePayload.result;
    } catch (error) {
      if (error instanceof TelegramBotError) throw error;
      throw createTelegramTransportError(error, {
        method,
        botToken,
        timedOut: abortContext.wasTimedOut(),
        aborted: requestOptions.signal?.aborted && !abortContext.wasTimedOut(),
      });
    } finally {
      abortContext.cleanup();
    }
  }

  return {
    getMe: (requestOptions) => request('getMe', {}, requestOptions),
    sendMessage(input = {}, requestOptions) {
      requireValue(input.chat_id, 'chat_id');
      requireValue(input.text, 'text');
      return request('sendMessage', input, requestOptions);
    },
    sendPhoto(input = {}, requestOptions = {}) {
      requireValue(input.chat_id, 'chat_id');
      requireValue(input.photo, 'photo');
      const multipart = Buffer.isBuffer(input.photo)
        || input.photo instanceof Uint8Array
        || Buffer.isBuffer(input.photo?.data)
        || input.photo?.data instanceof Uint8Array;
      return request('sendPhoto', input, { ...requestOptions, multipart });
    },
    editMessageText(input = {}, requestOptions) {
      requireValue(input.text, 'text');
      return request('editMessageText', input, requestOptions);
    },
    answerCallbackQuery(input = {}, requestOptions) {
      requireValue(input.callback_query_id, 'callback_query_id');
      return request('answerCallbackQuery', input, requestOptions);
    },
  };
}

module.exports = {
  createTelegramBotClient,
};
