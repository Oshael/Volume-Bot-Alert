const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodHolderSummaryWorker,
  __private,
} = require('../src/services/robinhood-holder-summary-worker');

const TOKENS = ['a', 'b', 'c'].map((letter) => `0x${letter.repeat(40)}`);
const NOW = Date.parse('2026-08-10T04:00:00.000Z');

function clock() {
  const scheduled = [];
  const cancelled = [];
  return {
    scheduled,
    cancelled,
    schedule(callback, delayMs) {
      const timer = { callback, delayMs, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    cancelSchedule(timer) { cancelled.push(timer); },
  };
}

describe('Robinhood holder summary worker', () => {
  it('updates hot/cold candidates independently and persists provider backoff', async () => {
    const successes = [];
    const failures = [];
    const candidates = [
      { tokenAddress: TOKENS[0], priority: 'hot', consecutiveFailures: 0 },
      { tokenAddress: TOKENS[1], priority: 'cold', consecutiveFailures: 0 },
      { tokenAddress: TOKENS[2], priority: 'cold', consecutiveFailures: 3 },
    ];
    const requestScheduler = {
      schedule: (task) => task(),
      getStatus: () => ({ circuitState: 'closed' }),
    };
    const worker = createRobinhoodHolderSummaryWorker({
      now: () => NOW,
      requestScheduler,
      repository: {
        listRefreshCandidates: async () => candidates,
        recordSuccess: async (input) => successes.push(input),
        recordFailure: async (input) => failures.push(input),
      },
      client: {
        async getTokenHolderSummary(tokenAddress) {
          if (tokenAddress === TOKENS[0]) return {
            available: true, holderCount: 4424, observedAt: new Date(NOW).toISOString(),
          };
          if (tokenAddress === TOKENS[1]) return { available: false };
          throw Object.assign(new Error('rate limited'), {
            code: 'rate_limited', retryable: true, retryAfterMs: 10_000,
          });
        },
      },
    });

    assert.deepEqual(await worker.runOnce(), {
      candidates: 3, hot: 1, cold: 2, updated: 1, unavailable: 1, failed: 1,
    });
    assert.deepEqual(successes, [{
      tokenAddress: TOKENS[0], holderCount: 4424, observedAt: '2026-08-10T04:00:00.000Z',
    }]);
    assert.equal(failures[0].errorCode, 'unavailable');
    assert.equal(failures[0].retryAfterAt, '2026-08-11T04:00:00.000Z');
    assert.equal(failures[1].errorCode, 'rate_limited');
    assert.equal(failures[1].retryAfterAt, '2026-08-10T04:00:10.000Z');
    assert.deepEqual(worker.getStatus().requestScheduler, { circuitState: 'closed' });
  });

  it('stays disabled by default and schedules bounded cycles only when enabled', async () => {
    const timers = clock();
    const worker = createRobinhoodHolderSummaryWorker({
      ...timers,
      repository: { listRefreshCandidates: async () => [] },
    });

    assert.equal(worker.start(), false);
    assert.equal(timers.scheduled.length, 0);
    assert.equal(worker.start({ enabled: true, intervalMs: 1, batchSize: 999 }), true);
    assert.equal(timers.scheduled[0].delayMs, 0);
    await timers.scheduled[0].callback();
    assert.equal(timers.scheduled[1].delayMs, 10_000);
    await worker.stop();
    assert.equal(timers.cancelled.length, 1);
  });

  it('bounds refresh and failure policies coherently', () => {
    const options = __private.normalizeOptions({
      hotRefreshMs: 900_000,
      coldRefreshMs: 300_000,
      failureBackoffMs: 600_000,
      maxFailureBackoffMs: 60_000,
    });
    assert.equal(options.coldRefreshMs, 900_000);
    assert.equal(options.maxFailureBackoffMs, 600_000);
    assert.equal(__private.safeErrorCode({ code: 'Bad Error!' }), 'bad_error_');
  });
});
