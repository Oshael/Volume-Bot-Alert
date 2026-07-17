const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  buildRobinhoodCatalogStagingTelemetry,
  createRobinhoodCatalogStagingWorker,
} = require(
  '../src/services/robinhood-catalog-staging-worker'
);

function createScheduler() {
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
    cancelSchedule(timer) {
      cancelled.push(timer);
    },
  };
}

describe('Robinhood catalog staging worker', () => {
  it('does not schedule while its explicit runtime switch is disabled', () => {
    const scheduler = createScheduler();
    const worker = createRobinhoodCatalogStagingWorker(scheduler);

    assert.equal(worker.start({ enabled: false }), false);
    assert.equal(worker.getStatus().running, false);
    assert.equal(scheduler.scheduled.length, 0);
  });

  it('rechecks rollout on every cycle and schedules the next interval', async () => {
    const scheduler = createScheduler();
    const rolloutStates = [
      { alertsRequested: true, publishable: false },
      { alertsRequested: true, publishable: true },
    ];
    const calls = [];
    const worker = createRobinhoodCatalogStagingWorker({
      ...scheduler,
      batch: {
        async runOnce(input) {
          calls.push(input);
          return { status: input.publishable ? 'completed' : 'blocked', staged: 0 };
        },
      },
    });

    assert.equal(worker.start({
      enabled: true,
      intervalMs: 30_000,
      rolloutProvider: async () => rolloutStates.shift(),
      signalConfig: { protocols: ['uniswap-v2'] },
    }), true);
    assert.equal(scheduler.scheduled[0].delayMs, 0);

    await scheduler.scheduled[0].callback();
    assert.equal(scheduler.scheduled[1].delayMs, 30_000);
    await scheduler.scheduled[1].callback();

    assert.deepEqual(calls.map((call) => call.publishable), [false, true]);
    assert.equal(worker.getStatus().totalRuns, 2);
    assert.equal(worker.getStatus().lastSummary.status, 'completed');
    await worker.stop();
    assert.equal(worker.getStatus().running, false);
    assert.equal(scheduler.cancelled.length, 1);
  });

  it('backs off after a failed cycle without losing subsequent recovery', async () => {
    const scheduler = createScheduler();
    let attempts = 0;
    const errors = [];
    const worker = createRobinhoodCatalogStagingWorker({
      ...scheduler,
      logger: { error: (message) => errors.push(message) },
      batch: {
        async runOnce() {
          attempts += 1;
          if (attempts === 1) throw new Error('temporary failure');
          return { status: 'completed', staged: 0 };
        },
      },
    });

    worker.start({
      enabled: true,
      intervalMs: 5000,
      maxErrorBackoffMs: 20_000,
      rolloutProvider: () => ({ alertsRequested: true, publishable: false }),
    });
    await scheduler.scheduled[0].callback();
    assert.equal(scheduler.scheduled[1].delayMs, 10_000);
    assert.equal(worker.getStatus().consecutiveErrors, 1);
    assert.match(errors[0], /temporary failure/);

    await scheduler.scheduled[1].callback();
    assert.equal(scheduler.scheduled[2].delayMs, 5000);
    assert.equal(worker.getStatus().consecutiveErrors, 0);
    assert.equal(worker.getStatus().totalErrors, 1);
    await worker.stop();
  });

  it('builds bounded lease telemetry without copying signal config or candidates', () => {
    const telemetry = buildRobinhoodCatalogStagingTelemetry({
      running: true,
      totalRuns: 3,
      lastDurationMs: 37,
      lastSummary: {
        status: 'shadow',
        reason: 'rollout_not_publishable',
        queried: 20,
        expectedSignals: 0,
        staged: 0,
        suppressed: 0,
        publication: {
          mode: 'shadow',
          evaluatedProfiles: 2,
          matchedProfiles: 1,
          evaluatedCustomRules: 3,
          matchedCustomRules: 1,
          intents: 1,
          delivery: {
            status: 'blocked',
            reason: 'shadow_only',
            attempted: 0,
            persisted: 0,
            duplicates: 0,
            notified: 0,
            publishErrors: 0,
            errors: 0,
            lastError: null,
          },
        },
        config: { secret: 'not-shared' },
        samples: [{ tokenAddress: 'not-shared' }],
      },
    }, () => Date.parse('2026-07-14T18:00:00.000Z'));

    assert.equal(telemetry.version, 1);
    assert.equal(telemetry.lastDurationMs, 37);
    assert.equal(telemetry.lastSummary.status, 'shadow');
    assert.equal(telemetry.lastSummary.reason, 'rollout_not_publishable');
    assert.equal(telemetry.lastSummary.publication.intents, 1);
    assert.equal(telemetry.lastSummary.publication.matchedCustomRules, 1);
    assert.equal(telemetry.lastSummary.publication.mode, 'shadow');
    assert.equal(telemetry.lastSummary.publication.deliveryStatus, 'blocked');
    assert.equal(telemetry.lastSummary.publication.deliveryReason, 'shadow_only');
    assert.equal(telemetry.lastSummary.publication.attempted, 0);
    assert.equal(telemetry.lastSummary.publication.persisted, 0);
    assert.equal(Object.hasOwn(telemetry.lastSummary, 'config'), false);
    assert.equal(Object.hasOwn(telemetry.lastSummary, 'samples'), false);
  });
});
