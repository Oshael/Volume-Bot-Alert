Object.assign(process.env, {
  TELEGRAM_ALERTS_ENABLED: 'false',
  TELEGRAM_BOT_TOKEN: ' config-token ',
  TELEGRAM_BOT_USERNAME: '@trend_bot',
  TELEGRAM_WEBHOOK_SECRET: 'hook-secret',
  TELEGRAM_WEBHOOK_PUBLIC_URL: 'https://example.test/telegram',
  TELEGRAM_DELIVERY_BATCH_SIZE: '999',
  TELEGRAM_DELIVERY_CONCURRENCY: '0',
  TELEGRAM_DELIVERY_TIMEOUT_MS: '1',
  TELEGRAM_MAX_ATTEMPTS: '99',
});

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { describe, it } = require('node:test');

const config = require('../config');
const { createTelegramBotClient } = require('../src/services/telegram-bot-client');
const {
  createTelegramApiError,
  decideTelegramDeliveryFailure,
  redactTelegramSecrets,
} = require('../src/services/telegram-error-policy');

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function clientWith(fetchImpl, options = {}) {
  return createTelegramBotClient({
    botToken: '123456:secret-token',
    enabled: true,
    fetchImpl,
    timeoutMs: 1_000,
    ...options,
  });
}

describe('Telegram Bot API client', () => {
  it('normalizes bounded Telegram runtime configuration while disabled', () => {
    assert.deepEqual(config.telegram, {
      enabled: false,
      botToken: 'config-token',
      botUsername: 'trend_bot',
      webhookSecret: 'hook-secret',
      webhookPublicUrl: 'https://example.test/telegram',
      deliveryBatchSize: 100,
      deliveryConcurrency: 1,
      deliveryTimeoutMs: 1_000,
      maxAttempts: 20,
    });
  });

  it('fails startup clearly when Telegram is enabled without required settings', () => {
    const child = spawnSync(process.execPath, ['-e', "require('./config')"], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        TELEGRAM_ALERTS_ENABLED: 'true',
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_BOT_USERNAME: '',
        TELEGRAM_WEBHOOK_SECRET: '',
        TELEGRAM_WEBHOOK_PUBLIC_URL: '',
      },
    });

    assert.equal(child.status, 1);
    for (const name of [
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_BOT_USERNAME',
      'TELEGRAM_WEBHOOK_SECRET',
      'TELEGRAM_WEBHOOK_PUBLIC_URL',
    ]) {
      assert.match(child.stderr, new RegExp(name));
    }
  });

  it('calls JSON methods and returns only the Bot API result', async () => {
    const calls = [];
    const client = clientWith(async (url, init) => {
      calls.push({ url, init });
      return response({ ok: true, result: { message_id: 42 } });
    });

    assert.deepEqual(
      await client.sendMessage({ chat_id: 123, text: 'hello', reply_markup: { inline_keyboard: [] } }),
      { message_id: 42 }
    );
    assert.equal(calls[0].url, 'https://api.telegram.org/bot123456:secret-token/sendMessage');
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      chat_id: 123,
      text: 'hello',
      reply_markup: { inline_keyboard: [] },
    });
  });

  it('supports getMe, edits, and callback answers', async () => {
    const methods = [];
    const client = clientWith(async (url) => {
      methods.push(url.split('/').at(-1));
      return response({ ok: true, result: true });
    });

    await client.getMe();
    await client.editMessageText({ chat_id: 1, message_id: 2, text: 'updated' });
    await client.answerCallbackQuery({ callback_query_id: 'callback-1' });
    assert.deepEqual(methods, ['getMe', 'editMessageText', 'answerCallbackQuery']);
  });

  it('uploads binary photos as multipart data', async () => {
    let body;
    const client = clientWith(async (_url, init) => {
      body = init.body;
      return response({ ok: true, result: { message_id: 7 } });
    });

    await client.sendPhoto({
      chat_id: 123,
      caption: '<b>alert</b>',
      reply_markup: { inline_keyboard: [[{ text: 'Open', url: 'https://example.test' }]] },
      photo: { data: Buffer.from('png'), filename: 'alert.png', contentType: 'image/png' },
    });

    assert.ok(body instanceof FormData);
    assert.equal(body.get('chat_id'), '123');
    assert.equal(body.get('caption'), '<b>alert</b>');
    assert.equal(body.get('reply_markup'), JSON.stringify({
      inline_keyboard: [[{ text: 'Open', url: 'https://example.test' }]],
    }));
    assert.equal(body.get('photo').name, 'alert.png');
    assert.equal(body.get('photo').type, 'image/png');
  });

  it('classifies flood control without leaking the bot token', async () => {
    const client = clientWith(async () => response({
      ok: false,
      error_code: 429,
      description: 'retry bot123456:secret-token',
      parameters: { retry_after: 6 },
    }, 429));

    await assert.rejects(client.sendMessage({ chat_id: 1, text: 'alert' }), (error) => {
      assert.equal(error.code, 'rate_limited');
      assert.equal(error.retryable, true);
      assert.equal(error.retryAfterSeconds, 6);
      assert.doesNotMatch(error.message, /secret-token/);
      return true;
    });
  });

  it('distinguishes permanent API errors from retryable server errors', () => {
    const blocked = createTelegramApiError({
      method: 'sendMessage',
      status: 403,
      payload: { description: 'Forbidden: bot was blocked by the user' },
    });
    const unavailable = createTelegramApiError({
      method: 'sendMessage',
      status: 502,
      payload: { description: 'Bad Gateway' },
    });

    assert.equal(blocked.code, 'bot_blocked');
    assert.equal(blocked.retryable, false);
    assert.equal(unavailable.code, 'api_unavailable');
    assert.equal(unavailable.retryable, true);
  });

  it('schedules bounded retries and respects Telegram retry_after', () => {
    const nowMs = Date.UTC(2026, 6, 29, 15);
    const decision = decideTelegramDeliveryFailure({
      attempts: 2,
      maxAttempts: 5,
      nowMs,
      error: {
        code: 'rate_limited',
        message: 'Too many requests',
        retryable: true,
        retryAfterSeconds: 45,
      },
    });

    assert.deepEqual(decision, {
      status: 'retry',
      errorCode: 'rate_limited',
      error: 'Too many requests',
      nextAttemptAt: new Date(nowMs + 45_000).toISOString(),
      delayMs: 45_000,
    });
  });

  it('terminalizes permanent errors and exhausted retryable failures', () => {
    const permanent = decideTelegramDeliveryFailure({
      attempts: 1,
      maxAttempts: 5,
      error: { code: 'bot_blocked', message: 'blocked', retryable: false },
    });
    const exhausted = decideTelegramDeliveryFailure({
      attempts: 5,
      maxAttempts: 5,
      error: { code: 'timeout', message: 'timed out', retryable: true },
    });

    assert.equal(permanent.status, 'failed');
    assert.equal(permanent.errorCode, 'bot_blocked');
    assert.equal(exhausted.status, 'failed');
    assert.equal(exhausted.errorCode, 'attempts_exhausted');
  });

  it('normalizes timeouts and respects caller cancellation', async () => {
    const fetchImpl = async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('request aborted'), { name: 'AbortError' }));
      });
    });
    const timeoutClient = clientWith(fetchImpl, { timeoutMs: 5 });
    await assert.rejects(timeoutClient.getMe(), { code: 'timeout', retryable: true });

    const controller = new AbortController();
    const cancelled = clientWith(fetchImpl);
    const pending = cancelled.getMe({ signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { code: 'aborted', retryable: false });
  });

  it('rejects disabled use and invalid required inputs locally', async () => {
    const disabled = createTelegramBotClient({
      botToken: 'token',
      enabled: false,
      fetchImpl: async () => {
        throw new Error('must not run');
      },
    });

    await assert.rejects(disabled.getMe(), { code: 'disabled' });
    assert.throws(() => clientWith(async () => {}).sendMessage({ text: 'missing chat' }), {
      code: 'invalid_request',
    });
  });

  it('redacts tokens embedded in Telegram request URLs', () => {
    assert.equal(
      redactTelegramSecrets(
        'fetch https://api.telegram.org/bot123456:secret-token/sendMessage failed',
        '123456:secret-token'
      ),
      'fetch https://api.telegram.org/bot[REDACTED]/sendMessage failed'
    );
  });
});
