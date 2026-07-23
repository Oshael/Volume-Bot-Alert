const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodRealtimeAlertWorker,
} = require('../src/services/robinhood-realtime-alert-worker');

const TOKEN = '0x1111111111111111111111111111111111111111';
const TOKEN_TWO = '0x2222222222222222222222222222222222222222';
const NOW = Date.parse('2026-07-18T18:00:01.000Z');

function update(address, observedAt, fdvUsd = null) {
  return {
    type: 'market:bucket',
    chain: 'robinhood',
    address,
    generatedAt: new Date(NOW).toISOString(),
    valuation: { observedAt, fdvUsd },
  };
}

function createSchedule() {
  const callbacks = [];
  return {
    callbacks,
    cancelSchedule() {},
    schedule(callback, delayMs) {
      callbacks.push({ callback, delayMs });
      return { unref() {} };
    },
  };
}

describe('Robinhood realtime alert worker', () => {
  it('coalesces committed token updates and publishes one targeted batch immediately', async () => {
    const reads = [];
    const publications = [];
    const scheduler = createSchedule();
    const worker = createRobinhoodRealtimeAlertWorker({
      ...scheduler,
      now: () => NOW,
      repository: {
        async listActiveTokenCandidatesByAddresses(input) {
          reads.push(input);
          return input.addresses.map((tokenAddress) => ({ tokenAddress }));
        },
      },
      publication: {
        async runCandidates(candidates, input) {
          publications.push({ candidates, input });
          return { status: 'completed' };
        },
      },
    });
    worker.start({
      enabled: true,
      signalConfig: { windowMs: 300000 },
      rolloutProvider: async () => ({ alertsRequested: true, publishable: true }),
    });

    assert.equal(worker.enqueue(update(TOKEN.toUpperCase(), '2026-07-18T18:00:00.100Z')), true);
    assert.equal(worker.enqueue(update(TOKEN, '2026-07-18T18:00:00.500Z')), true);
    assert.equal(worker.enqueue(update(TOKEN_TWO, '2026-07-18T18:00:00.800Z')), true);
    assert.equal(scheduler.callbacks.length, 1);
    assert.equal(scheduler.callbacks[0].delayMs, 25);
    await worker.flush();

    assert.deepEqual(reads[0].addresses, [TOKEN, TOKEN_TWO]);
    assert.equal(reads[0].asOf.toISOString(), '2026-07-18T18:00:00.800Z');
    assert.equal(reads[0].statementTimeoutMs, 1500);
    assert.equal(publications[0].candidates.length, 2);
    assert.equal(publications[0].input.asOf.toISOString(), '2026-07-18T18:00:00.800Z');
    assert.equal(worker.getStatus().queued, 3);
    assert.equal(worker.getStatus().processed, 2);
    await worker.stop();
  });

  it('drops stale updates and checks rollout before reading candidates', async () => {
    let reads = 0;
    const worker = createRobinhoodRealtimeAlertWorker({
      ...createSchedule(),
      now: () => NOW,
      repository: {
        async listActiveTokenCandidatesByAddresses() { reads += 1; return []; },
      },
      publication: { async runCandidates() { throw new Error('must not publish'); } },
    });
    worker.start({
      enabled: true,
      maxEventLagMs: 1000,
      signalConfig: { windowMs: 300000 },
      rolloutProvider: async () => ({ alertsRequested: true, publishable: false }),
    });

    assert.equal(worker.enqueue(update(TOKEN, '2026-07-18T17:59:50.000Z')), false);
    assert.equal(worker.enqueue(update(TOKEN, '2026-07-18T18:00:00.500Z')), true);
    await worker.flush();

    assert.equal(reads, 0);
    assert.equal(worker.getStatus().skippedStale, 1);
    assert.equal(worker.getStatus().skippedRollout, 1);
    await worker.stop();
  });

  it('does not queue a token at the global FDV cap', async () => {
    const worker = createRobinhoodRealtimeAlertWorker({
      ...createSchedule(),
      now: () => NOW,
    });
    worker.start({ enabled: true, signalConfig: { windowMs: 300000 } });

    assert.equal(worker.enqueue(
      update(TOKEN, '2026-07-18T18:00:00.500Z', 30_000_000_000)
    ), false);
    assert.equal(worker.getStatus().skippedFdvCap, 1);
    assert.equal(worker.getStatus().queued, 0);
    await worker.stop();
  });
});
