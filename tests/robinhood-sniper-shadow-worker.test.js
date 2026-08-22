const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodSniperShadowWorker,
} = require('../src/services/robinhood-sniper-shadow-worker');

const TOKEN_A = `0x${'1'.repeat(40)}`;

describe('Robinhood SNIPER shadow worker', () => {
  it('pages batches, resets the scan after exhaustion, and exposes telemetry', async () => {
    const inputs = [];
    const finalResult = {
      mode: 'shadow', candidates: 0, completed: 0, deferred: 0, failed: 0,
      nextToken: null, exhausted: true,
    };
    const results = [
      {
        mode: 'shadow', candidates: 2, completed: 1, deferred: 1, failed: 0,
        nextToken: TOKEN_A, exhausted: false,
      },
      finalResult,
    ];
    const worker = createRobinhoodSniperShadowWorker({
      runner: { runBatch: async (input) => {
        inputs.push(input);
        return results.shift();
      } },
    });

    await worker.runOnce();
    await worker.runOnce();

    assert.deepEqual(inputs, [
      { limit: 10, concurrency: 1, retryMs: 3_600_000, afterToken: null },
      { limit: 10, concurrency: 1, retryMs: 3_600_000, afterToken: TOKEN_A },
    ]);
    assert.deepEqual(worker.getStatus(), {
      enabled: false, running: false, inFlight: false, mode: 'shadow',
      totalRuns: 2, totalCandidates: 2, totalCompleted: 1,
      totalDeferred: 1, totalFailed: 0, consecutiveErrors: 0,
      scanAfterToken: null, lastResult: finalResult, lastError: null,
      lastCompletedAt: worker.getStatus().lastCompletedAt,
    });
    assert.match(worker.getStatus().lastCompletedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('contains tick errors, deduplicates active runs, and applies backoff', async () => {
    const scheduled = [];
    const warnings = [];
    let release;
    let calls = 0;
    const worker = createRobinhoodSniperShadowWorker({
      runner: { runBatch: async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('database unavailable'), { code: 'db_down' });
        return new Promise((resolve) => { release = resolve; });
      } },
      logger: { warn: (...args) => warnings.push(args) },
      schedule: (fn, delay) => {
        scheduled.push({ fn, delay });
        return { unref() {} };
      },
      cancelSchedule() {},
    });

    assert.equal(worker.start({ enabled: true, intervalMs: 1000 }), true);
    assert.equal(scheduled[0].delay, 0);
    await scheduled.shift().fn();
    assert.equal(scheduled[0].delay, 2000);
    assert.equal(worker.getStatus().lastError.code, 'db_down');
    assert.equal(warnings.length, 1);

    const first = worker.runOnce();
    const second = worker.runOnce();
    assert.equal(calls, 2);
    release({
      mode: 'shadow', candidates: 0, completed: 0, deferred: 0, failed: 0,
      nextToken: null, exhausted: true,
    });
    await Promise.all([first, second]);
    await worker.stop();
    assert.equal(worker.getStatus().running, false);
  });

  it('stays opt-in and rejects unsafe controls', () => {
    const worker = createRobinhoodSniperShadowWorker({
      runner: { runBatch: async () => ({}) },
    });

    assert.equal(worker.start(), false);
    assert.throws(() => worker.start({ enabled: true, concurrency: 5 }), /concurrency/);
    assert.throws(() => createRobinhoodSniperShadowWorker({ runner: {} }), /runner is invalid/);
  });
});
