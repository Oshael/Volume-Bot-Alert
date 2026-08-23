const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodInsiderShadowWorker,
} = require('../src/services/robinhood-insider-shadow-worker');

const TOKEN = `0x${'1'.repeat(40)}`;

describe('Robinhood INSIDER shadow worker', () => {
  it('pages the catalog, resets after exhaustion, and exposes telemetry', async () => {
    const inputs = [];
    const results = [
      { mode: 'shadow', candidates: 1, completed: 1, deferred: 0, failed: 0,
        nextToken: TOKEN, exhausted: false },
      { mode: 'shadow', candidates: 0, completed: 0, deferred: 0, failed: 0,
        nextToken: null, exhausted: true },
    ];
    const worker = createRobinhoodInsiderShadowWorker({
      runner: { runBatch: async (input) => { inputs.push(input); return results.shift(); } },
    });
    await worker.runOnce();
    await worker.runOnce();
    assert.equal(inputs[1].afterToken, TOKEN);
    assert.equal(worker.getStatus().scanAfterToken, null);
    assert.equal(worker.getStatus().totalCandidates, 1);
    assert.equal(worker.getStatus().totalCompleted, 1);
  });

  it('is opt-in, deduplicates runs, and backs off after tick errors', async () => {
    const scheduled = [];
    let calls = 0;
    let release;
    const worker = createRobinhoodInsiderShadowWorker({
      runner: { runBatch: async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('db down'), { code: 'db_down' });
        return new Promise((resolve) => { release = resolve; });
      } },
      logger: { warn() {} },
      schedule: (fn, delay) => { scheduled.push({ fn, delay }); return { unref() {} }; },
      cancelSchedule() {},
    });
    assert.equal(worker.start(), false);
    assert.equal(worker.start({ enabled: true, intervalMs: 1000 }), true);
    await scheduled.shift().fn();
    assert.equal(scheduled[0].delay, 2000);
    assert.equal(worker.getStatus().lastError.code, 'db_down');
    const first = worker.runOnce();
    const second = worker.runOnce();
    assert.equal(calls, 2);
    release({ mode: 'shadow', candidates: 0, completed: 0, deferred: 0, failed: 0,
      nextToken: null, exhausted: true });
    await Promise.all([first, second]);
    await worker.stop();
    assert.throws(() => createRobinhoodInsiderShadowWorker({ runner: {} }), /runner is invalid/);
  });
});
