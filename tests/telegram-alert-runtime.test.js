const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createTelegramAlertRuntime,
} = require('../src/services/telegram-alert-runtime');

function runtime(overrides = {}) {
  const calls = [];
  const timers = [];
  const instance = createTelegramAlertRuntime({
    enabled: true,
    settings: {
      enabled: true,
      deliveryBatchSize: 25,
      deliveryConcurrency: 4,
      deliveryIntervalMs: 1_000,
      deliveryMaxErrorBackoffMs: 8_000,
      maxAttempts: 5,
    },
    owner: 'telegram-runtime-test',
    deliveryWorker: {
      async runOnce() {
        calls.push('delivery');
        if (overrides.deliveryError) throw overrides.deliveryError;
        return overrides.deliverySummary || { claimed: 0, sent: 0 };
      },
    },
    reactivationReconciler: {
      async reconcile(input) {
        calls.push(['reactivation', input]);
        if (overrides.reactivationError) throw overrides.reactivationError;
        return { scanned: 0, reactivated: 0 };
      },
    },
    now: overrides.now || (() => Date.parse('2026-08-01T18:00:00.000Z')),
    schedule(callback, delay) {
      const handle = { callback, delay, unref() {} };
      timers.push(handle);
      return handle;
    },
    cancelSchedule(handle) { calls.push(['cancel', handle.delay]); },
    async onRuntimeError(input) { calls.push(['error', input.phase]); },
  });
  return { calls, instance, timers };
}

describe('Telegram alert runtime', () => {
  it('stays inert while Telegram is disabled without constructing adapters', async () => {
    const instance = createTelegramAlertRuntime({ enabled: false });

    assert.equal(instance.start(), false);
    assert.deepEqual(await instance.runOnce(), { enabled: false });
    assert.equal(instance.getStatus().running, false);
  });

  it('drains delivery before reconciling reactivation', async () => {
    const { calls, instance } = runtime();

    assert.deepEqual(await instance.runOnce(), {
      enabled: true,
      delivery: { claimed: 0, sent: 0 },
      reactivation: { scanned: 0, reactivated: 0 },
      errors: 0,
    });
    assert.deepEqual(calls, [
      'delivery',
      ['reactivation', { now: new Date('2026-08-01T18:00:00.000Z') }],
    ]);
    assert.equal(instance.getStatus().totalRuns, 1);
  });

  it('composes the delivery worker through Bot API settlement', async () => {
    const calls = [];
    const delivery = {
      id: '71', attempts: 1, chain: 'solana',
      tokenAddress: '11111111111111111111111111111111',
      eventPayload: { kind: 'monitored-vol', payload: { symbol: 'TEST' } },
      triggeredAt: '2026-08-01T18:00:00.000Z',
    };
    const instance = createTelegramAlertRuntime({
      enabled: true,
      settings: {
        enabled: true, deliveryBatchSize: 1, deliveryConcurrency: 1, maxAttempts: 3,
      },
      owner: 'telegram-runtime-composition',
      bot: {
        async sendMessage(input) {
          calls.push(['send', input]);
          return { message_id: 501 };
        },
        async sendPhoto() { throw new Error('photo should not be used'); },
      },
      formatter: {
        format() { return { text: '<b>TEST</b>', parseMode: 'HTML' }; },
      },
      contextSource: {
        async load() {
          return {
            senderInput: {
              chatId: '9007199254740993',
              sparklineEnabled: true,
              sparklineHours: 24,
              sparklineGranularityMinutes: 5,
            },
          };
        },
      },
      marketHistory: {
        async getSparklineBatch() { return { items: [{ series: [] }] }; },
      },
      sparklineRenderer: {
        async render() { return { kind: 'fallback', reason: 'insufficient_history' }; },
      },
      accessGate: { async authorize() { return { allowed: true }; } },
      deliveryModel: {
        async claimReadyBatch() { return [delivery]; },
        async renewClaims() { return [{ id: '71' }]; },
        async markSent(input) { calls.push(['settle', input]); return { status: 'sent' }; },
        async scheduleRetry() { return null; },
        async markFailed() { return null; },
        async cancelClaim() { return null; },
      },
      reactivationReconciler: {
        async reconcile() { return { scanned: 0, reactivated: 0 }; },
      },
    });

    const result = await instance.runOnce();

    assert.equal(result.delivery.sent, 1);
    assert.equal(calls[0][0], 'send');
    assert.equal(calls[1][0], 'settle');
    assert.equal(calls[1][1].messageId, '501');
    assert.equal(instance.getStatus().sparklineFallbacks, 1);
    assert.ok(instance.getStatus().lastSparklineFallbackAt);
  });

  it('does not reactivate when delivery draining fails', async () => {
    const { calls, instance } = runtime({ deliveryError: new Error('outbox unavailable') });

    const result = await instance.runOnce();

    assert.equal(result.errors, 1);
    assert.equal(result.reactivation, null);
    assert.deepEqual(calls, ['delivery', ['error', 'delivery']]);
    assert.equal(instance.getStatus().consecutiveErrors, 1);
  });

  it('does not reactivate while a delivery claim remains unsettled', async () => {
    const { calls, instance } = runtime({
      deliverySummary: { claimed: 1, sent: 0, errors: 1 },
    });

    const result = await instance.runOnce();

    assert.equal(result.errors, 1);
    assert.equal(result.reactivation, null);
    assert.deepEqual(calls, ['delivery', ['error', 'delivery-settlement']]);
  });

  it('schedules serial cycles with error backoff and stops cleanly', async () => {
    const { calls, instance, timers } = runtime({
      reactivationError: new Error('reactivation unavailable'),
    });

    assert.equal(instance.start(), true);
    assert.equal(instance.start(), false);
    assert.equal(timers[0].delay, 0);
    await timers[0].callback();
    assert.equal(timers[1].delay, 2_000);
    assert.equal(instance.getStatus().running, true);

    await instance.stop();
    assert.equal(instance.getStatus().running, false);
    assert.deepEqual(calls.at(-1), ['cancel', 2_000]);
  });
});
