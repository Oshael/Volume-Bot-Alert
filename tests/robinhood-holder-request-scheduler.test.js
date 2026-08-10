const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  RobinhoodHolderSchedulerError,
  createRobinhoodHolderRequestScheduler,
  parseRetryAfterMs,
} = require('../src/services/robinhood-holder-request-scheduler');

function createClock() {
  let current = 0;
  const delays = [];
  return {
    now: () => current,
    sleep: async (ms) => {
      delays.push(ms);
      current += ms;
    },
    advance: (ms) => { current += ms; },
    delays,
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function providerError(code, details = {}) {
  return Object.assign(new Error(code), { code, retryable: true, ...details });
}

describe('Robinhood holder request scheduler', () => {
  it('spaces attempt starts and caps active requests', async () => {
    const clock = createClock();
    const scheduler = createRobinhoodHolderRequestScheduler({
      now: clock.now,
      sleep: clock.sleep,
      requestsPerSecond: 2,
      concurrency: 2,
      maxRetries: 0,
    });
    const starts = [];
    const releases = [];
    let active = 0;
    let maxActive = 0;
    const task = () => scheduler.schedule(() => new Promise((resolve) => {
      starts.push(clock.now());
      active += 1;
      maxActive = Math.max(maxActive, active);
      releases.push(() => {
        active -= 1;
        resolve('ok');
      });
    }));

    const first = task();
    const second = task();
    const third = task();
    await tick();

    assert.deepEqual(starts, [0, 500]);
    assert.equal(maxActive, 2);
    assert.equal(scheduler.getStatus().queued, 1);

    releases[0]();
    await tick();
    assert.deepEqual(starts, [0, 500, 1000]);
    releases[1]();
    releases[2]();
    assert.deepEqual(await Promise.all([first, second, third]), ['ok', 'ok', 'ok']);
  });

  it('honors Retry-After, then uses exponential jitter for transient failures', async () => {
    const clock = createClock();
    const scheduler = createRobinhoodHolderRequestScheduler({
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
      maxRetries: 2,
      baseBackoffMs: 1000,
    });
    let attempts = 0;

    const result = await scheduler.schedule(() => {
      attempts += 1;
      if (attempts === 1) throw providerError('rate_limited', { retryAfter: '2' });
      if (attempts === 2) throw providerError('timeout');
      return 'recovered';
    });

    assert.equal(result, 'recovered');
    assert.deepEqual(clock.delays, [2000, 1600]);
    assert.deepEqual(scheduler.getStatus(), {
      circuitState: 'closed',
      consecutiveFailures: 0,
      active: 1,
      queued: 0,
      requests: 1,
      attempts: 3,
      successes: 1,
      failures: 0,
      retries: 2,
      rateLimited: 1,
      timeouts: 1,
      circuitOpened: 0,
    });
  });

  it('does not retry or trip the circuit for definitive provider responses', async () => {
    const clock = createClock();
    const scheduler = createRobinhoodHolderRequestScheduler({
      now: clock.now,
      sleep: clock.sleep,
      maxRetries: 3,
      circuitFailureThreshold: 1,
    });
    let attempts = 0;
    const unavailable = Object.assign(new Error('not found'), {
      code: 'unavailable',
      retryable: false,
    });

    await assert.rejects(scheduler.schedule(() => {
      attempts += 1;
      throw unavailable;
    }), unavailable);

    assert.equal(attempts, 1);
    assert.equal(scheduler.getStatus().circuitState, 'closed');
    assert.equal(scheduler.getStatus().failures, 1);
  });

  it('opens after consecutive transient failures and admits one recovery probe', async () => {
    const clock = createClock();
    const scheduler = createRobinhoodHolderRequestScheduler({
      now: clock.now,
      sleep: clock.sleep,
      maxRetries: 0,
      circuitFailureThreshold: 2,
      circuitResetMs: 1000,
    });

    await assert.rejects(scheduler.schedule(() => { throw providerError('timeout'); }));
    await assert.rejects(scheduler.schedule(() => { throw providerError('transport_error'); }));
    await assert.rejects(
      scheduler.schedule(() => 'blocked'),
      (error) => error instanceof RobinhoodHolderSchedulerError && error.code === 'circuit_open'
    );

    clock.advance(1000);
    let releaseProbe;
    const probe = scheduler.schedule(() => new Promise((resolve) => { releaseProbe = resolve; }));
    await tick();
    await assert.rejects(
      scheduler.schedule(() => 'second probe'),
      (error) => error.code === 'circuit_open'
    );
    releaseProbe('healthy');

    assert.equal(await probe, 'healthy');
    assert.equal(scheduler.getStatus().circuitState, 'closed');
    assert.equal(scheduler.getStatus().circuitOpened, 1);
  });

  it('parses both Retry-After formats', () => {
    const now = Date.parse('2026-08-10T00:00:00.000Z');
    assert.equal(parseRetryAfterMs({ retryAfter: '1.5' }, now), 1500);
    assert.equal(parseRetryAfterMs({ retryAfter: 'Mon, 10 Aug 2026 00:00:03 GMT' }, now), 3000);
    assert.equal(parseRetryAfterMs({}, now), null);
  });
});
