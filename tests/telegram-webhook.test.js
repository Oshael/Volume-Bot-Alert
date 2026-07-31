const express = require('express');
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const request = require('supertest');

const telegramWebhookRouter = require('../src/routes/telegram-webhook');
const {
  createTelegramUpdateProcessor,
} = require('../src/services/telegram-update-processor');

const WEBHOOK_SECRET = 'staging-webhook-secret';
const SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';

function appWith(processor, settings = {}) {
  const app = express();
  app.use('/api/telegram/webhook', telegramWebhookRouter.createTelegramWebhookRouter({
    settings: {
      enabled: true,
      webhookSecret: WEBHOOK_SECRET,
      ...settings,
    },
    processor,
    logger: { error() {} },
  }));
  return app;
}

function validRequest(app, payload = { update_id: 123 }) {
  return request(app)
    .post('/api/telegram/webhook')
    .set(SECRET_HEADER, WEBHOOK_SECRET)
    .set('Content-Type', 'application/json')
    .send(payload);
}

describe('Telegram webhook ingress', () => {
  it('fails closed when disabled or when the processor is not assembled', async () => {
    const disabled = await validRequest(appWith(null, { enabled: false }));
    const unavailable = await validRequest(appWith(null));

    assert.equal(disabled.status, 503);
    assert.equal(unavailable.status, 503);
  });

  it('requires the Telegram secret and JSON without browser-origin middleware', async () => {
    let calls = 0;
    const processor = { process: async () => { calls += 1; } };
    const app = appWith(processor);

    const missingSecret = await request(app)
      .post('/api/telegram/webhook')
      .set('Content-Type', 'application/json')
      .send({ update_id: 1 });
    const wrongSecret = await request(app)
      .post('/api/telegram/webhook')
      .set(SECRET_HEADER, 'wrong-secret')
      .set('Content-Type', 'application/json')
      .send({ update_id: 2 });
    const wrongType = await request(app)
      .post('/api/telegram/webhook')
      .set(SECRET_HEADER, WEBHOOK_SECRET)
      .set('Content-Type', 'text/plain')
      .send('{"update_id":3}');
    const accepted = await validRequest(app, { update_id: 4 });

    assert.equal(missingSecret.status, 401);
    assert.equal(wrongSecret.status, 401);
    assert.equal(wrongType.status, 415);
    assert.equal(accepted.status, 200);
    assert.equal(calls, 1);
  });

  it('rejects malformed and oversized payloads before processing', async () => {
    let calls = 0;
    const app = appWith({ process: async () => { calls += 1; } });

    const malformed = await request(app)
      .post('/api/telegram/webhook')
      .set(SECRET_HEADER, WEBHOOK_SECRET)
      .set('Content-Type', 'application/json')
      .send('{"update_id":');
    const oversized = await validRequest(app, {
      update_id: 5,
      message: { text: 'x'.repeat(70 * 1024) },
    });

    assert.equal(malformed.status, 400);
    assert.equal(oversized.status, 413);
    assert.equal(calls, 0);
  });
});

describe('Telegram update processor', () => {
  it('processes a persisted update once and skips completed duplicates', async () => {
    const terminalUpdates = [];
    let intakeCalls = 0;
    let handlerCalls = 0;
    const processor = createTelegramUpdateProcessor({
      updateModel: {
        async receive() {
          intakeCalls += 1;
          return intakeCalls === 1 ? { update_id: '123', status: 'received' } : null;
        },
        async markProcessed(updateId) {
          terminalUpdates.push(['processed', updateId]);
        },
        async markFailed() {
          assert.fail('successful updates must not be marked failed');
        },
      },
      async handleUpdate(update) {
        handlerCalls += 1;
        assert.equal(update.message.text, '/start');
      },
    });

    const first = await processor.process({ update_id: 123, message: { text: '/start' } });
    const duplicate = await processor.process({ update_id: 123, message: { text: '/start' } });

    assert.deepEqual(first, { status: 'processed', updateId: '123' });
    assert.deepEqual(duplicate, { status: 'duplicate', updateId: '123' });
    assert.equal(handlerCalls, 1);
    assert.deepEqual(terminalUpdates, [['processed', '123']]);
  });

  it('records only a normalized error code and leaves failed updates retryable', async () => {
    const terminalUpdates = [];
    let handlerCalls = 0;
    const processor = createTelegramUpdateProcessor({
      updateModel: {
        async receive() {
          return { update_id: '456', status: 'received' };
        },
        async markProcessed(updateId) {
          terminalUpdates.push(['processed', updateId]);
        },
        async markFailed(updateId, code) {
          terminalUpdates.push(['failed', updateId, code]);
        },
      },
      async handleUpdate() {
        handlerCalls += 1;
        if (handlerCalls === 1) {
          const error = new Error('private message and deep-link token');
          error.code = 'BOT API/TIMEOUT';
          throw error;
        }
      },
    });

    await assert.rejects(() => processor.process({ update_id: 456 }), /private message/);
    const retry = await processor.process({ update_id: 456 });

    assert.deepEqual(terminalUpdates, [
      ['failed', '456', 'bot_api_timeout'],
      ['processed', '456'],
    ]);
    assert.deepEqual(retry, { status: 'processed', updateId: '456' });
  });

  it('rejects invalid or out-of-range update IDs before persistence', async () => {
    const processor = createTelegramUpdateProcessor({
      updateModel: {
        async receive() {
          assert.fail('invalid updates must not reach persistence');
        },
      },
      async handleUpdate() {},
    });

    await assert.rejects(
      () => processor.process({ update_id: 'not-an-integer' }),
      /update_id must be a non-negative integer/
    );
    await assert.rejects(
      () => processor.process({ update_id: '9223372036854775808' }),
      /outside the supported range/
    );
  });
});
