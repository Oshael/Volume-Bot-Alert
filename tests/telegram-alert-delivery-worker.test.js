const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createTelegramAlertDeliveryWorker,
} = require('../src/services/telegram-alert-delivery-worker');

function claim(id, attempts = 1) {
  return {
    id: String(id),
    attempts,
    chain: 'solana',
    tokenAddress: '11111111111111111111111111111111',
    eventPayload: { kind: 'monitored-vol', payload: { symbol: `T${id}` } },
    triggeredAt: '2026-07-29T15:00:00.000Z',
  };
}

function context() {
  return {
    senderInput: {
      chatId: '9007199254740993',
      sparklineEnabled: true,
      sparklineHours: 24,
      sparklineGranularityMinutes: 5,
    },
  };
}

function createHarness(overrides = {}) {
  const calls = {
    claim: [], renew: [], heartbeatCancel: [], context: [], access: [],
    send: [], settlements: [], errors: [],
  };
  const claimed = overrides.claimed || [claim(1)];
  const settle = (status) => async (input) => {
    calls.settlements.push({ status, input });
    if (overrides.settlementError === status) throw new Error('settlement offline');
    if (overrides.staleSettlement) return null;
    return { id: input.id, status };
  };
  const worker = createTelegramAlertDeliveryWorker({
    owner: 'telegram-worker-test',
    batchSize: 10,
    concurrency: overrides.concurrency || 2,
    leaseMs: 60_000,
    maxAttempts: 3,
    now: () => Date.UTC(2026, 6, 29, 15, 0, 0),
    deliveryModel: {
      async claimReadyBatch(input) { calls.claim.push(input); return claimed; },
      async renewClaims(input) {
        calls.renew.push(input);
        const losesLease = overrides.staleRenewal
          || (overrides.loseHeartbeat && calls.renew.length > 1);
        return losesLease ? [] : input.ids.map((id) => ({ id }));
      },
      markSent: settle('sent'),
      scheduleRetry: settle('retry'),
      markFailed: settle('failed'),
      cancelClaim: settle('cancelled'),
    },
    contextSource: {
      async load(input) {
        calls.context.push(input);
        if (overrides.contextError) throw overrides.contextError;
        return overrides.contextValue === undefined ? context() : overrides.contextValue;
      },
    },
    accessGate: {
      async authorize(input) {
        calls.access.push(input);
        if (overrides.accessError) throw overrides.accessError;
        return overrides.authorization || { allowed: true };
      },
    },
    sender: {
      async send(input) {
        calls.send.push(input);
        if (overrides.sendError) throw overrides.sendError;
        if (overrides.onSend) await overrides.onSend(input);
        return { messageId: '501', fileId: 'photo-file' };
      },
    },
    scheduleHeartbeat: overrides.scheduleHeartbeat,
    cancelHeartbeat: overrides.cancelHeartbeat,
    onDeliveryError(input) { calls.errors.push(input); },
  });
  return { calls, worker };
}

describe('Telegram alert delivery worker', () => {
  it('claims, authorizes, sends and settles successful deliveries', async () => {
    const { calls, worker } = createHarness({ claimed: [claim(1), claim(2)] });
    const result = await worker.runOnce();

    assert.deepEqual(calls.claim[0], {
      owner: 'telegram-worker-test', limit: 10, leaseMs: 60_000,
    });
    assert.equal(calls.context.length, 2);
    assert.equal(calls.access.length, 2);
    assert.equal(calls.renew.length, 2);
    assert.equal(calls.send[0].chatId, '9007199254740993');
    assert.equal(calls.settlements.every(({ status }) => status === 'sent'), true);
    assert.deepEqual(result, {
      claimed: 2, sent: 2, retry: 0, failed: 0, cancelled: 0, stale: 0, errors: 0,
    });
  });

  it('cancels a denied delivery without calling the sender', async () => {
    const { calls, worker } = createHarness({
      authorization: {
        allowed: false,
        code: 'access_revoked',
        message: 'TrendScope access was revoked',
      },
    });
    const result = await worker.runOnce();

    assert.equal(calls.send.length, 0);
    assert.equal(calls.settlements[0].status, 'cancelled');
    assert.equal(calls.settlements[0].input.errorCode, 'access_revoked');
    assert.equal(result.cancelled, 1);
  });

  it('schedules retry for transient sender and access-check failures', async () => {
    const retryable = Object.assign(new Error('Telegram timeout'), {
      code: 'timeout', retryable: true,
    });
    const senderFailure = createHarness({ sendError: retryable });
    const accessFailure = createHarness({ accessError: new Error('access database offline') });

    const [senderResult, accessResult] = await Promise.all([
      senderFailure.worker.runOnce(), accessFailure.worker.runOnce(),
    ]);

    assert.equal(senderResult.retry, 1);
    assert.equal(senderFailure.calls.settlements[0].input.errorCode, 'timeout');
    assert.equal(accessResult.retry, 1);
    assert.equal(accessFailure.calls.send.length, 0);
    assert.equal(accessFailure.calls.settlements[0].input.errorCode, 'access_check_error');
  });

  it('fails permanent errors and does not count a lost lease as delivered', async () => {
    const permanent = Object.assign(new Error('bot blocked'), {
      code: 'bot_blocked', retryable: false,
    });
    const failed = createHarness({ sendError: permanent });
    const stale = createHarness({ staleSettlement: true });

    const [failedResult, staleResult] = await Promise.all([
      failed.worker.runOnce(), stale.worker.runOnce(),
    ]);

    assert.equal(failedResult.failed, 1);
    assert.equal(failed.calls.settlements[0].input.errorCode, 'bot_blocked');
    assert.equal(staleResult.sent, 0);
    assert.equal(staleResult.stale, 1);
  });

  it('does not call the Bot API after losing lease ownership', async () => {
    const { calls, worker } = createHarness({ staleRenewal: true });

    const result = await worker.runOnce();

    assert.equal(calls.send.length, 0);
    assert.equal(calls.settlements.length, 0);
    assert.equal(result.stale, 1);
  });

  it('bounds concurrent calls to the sender', async () => {
    let active = 0;
    let maximum = 0;
    const { worker } = createHarness({
      claimed: [claim(1), claim(2), claim(3), claim(4), claim(5)],
      concurrency: 2,
      async onSend() {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
      },
    });

    const result = await worker.runOnce();

    assert.equal(result.sent, 5);
    assert.equal(maximum, 2);
  });

  it('blocks settlement when a heartbeat loses lease ownership during send', async () => {
    let heartbeatTick;
    let releaseSend;
    const sendGate = new Promise((resolve) => { releaseSend = resolve; });
    const { calls, worker } = createHarness({
      loseHeartbeat: true,
      scheduleHeartbeat(callback) {
        heartbeatTick = callback;
        return 'telegram-heartbeat';
      },
      cancelHeartbeat(handle) { calls.heartbeatCancel.push(handle); },
      async onSend() { await sendGate; },
    });

    const running = worker.runOnce();
    await new Promise((resolve) => setImmediate(resolve));
    heartbeatTick();
    await new Promise((resolve) => setImmediate(resolve));
    releaseSend();
    const result = await running;

    assert.equal(result.errors, 1);
    assert.equal(calls.send.length, 1);
    assert.equal(calls.settlements.length, 0);
    assert.deepEqual(calls.heartbeatCancel, ['telegram-heartbeat']);
    assert.equal(calls.errors[0].error.code, 'delivery_lease_lost');
  });

  it('leaves a claim recoverable when persistence cannot settle it', async () => {
    const { calls, worker } = createHarness({
      settlementError: 'sent',
    });

    const result = await worker.runOnce();

    assert.equal(result.errors, 1);
    assert.equal(calls.send.length, 1);
    assert.deepEqual(calls.settlements.map(({ status }) => status), ['sent']);
    assert.equal(calls.errors[0].phase, 'settlement');
  });
});
