const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodDerivedLiveSinks,
  __private: { evaluateDerivedPipelineHealth },
} = require('../src/services/robinhood-derived-live-sinks');

const NOW = Date.parse('2026-08-06T01:00:00.000Z');

function healthyLeases() {
  return [
    {
      key: 'robinhood-head-capture-worker',
      leaseUntil: new Date(NOW + 60_000).toISOString(),
      metadata: { telemetry: {
        capturedAt: new Date(NOW - 1000).toISOString(),
        worker: { running: true },
        coverage: { caughtUp: true, unexplainedGaps: 0 },
      } },
    },
    {
      key: 'robinhood-processing-worker',
      leaseUntil: new Date(NOW + 60_000).toISOString(),
      metadata: { telemetry: {
        running: true,
        lastTickAt: new Date(NOW - 1000).toISOString(),
        lastBlocked: 0,
        lastError: null,
      } },
    },
  ];
}

function fakeWorker(name, calls) {
  return {
    start: (options) => { calls.push(`${name}:start`); return options.enabled === true; },
    stop: async () => { calls.push(`${name}:stop`); },
    getStatus: () => ({ name }),
  };
}

describe('robinhood derived live sinks', () => {
  it('requires fresh, caught-up head and healthy processing leases', () => {
    assert.deepEqual(
      evaluateDerivedPipelineHealth(healthyLeases(), { nowMs: NOW }),
      { ready: true, blockers: [] }
    );

    const unhealthy = healthyLeases();
    unhealthy[0].metadata.telemetry.capturedAt = new Date(NOW - 120_000).toISOString();
    unhealthy[1].metadata.telemetry.lastBlocked = 2;
    assert.deepEqual(
      evaluateDerivedPipelineHealth(unhealthy, { nowMs: NOW }).blockers,
      ['head_telemetry_stale', 'processing_blocked']
    );
  });

  it('starts all sinks only behind the live ownership gate and stops them together', async () => {
    const calls = [];
    const sinks = createRobinhoodDerivedLiveSinks({
      enabled: true,
      realtimeAlertsEnabled: true,
      realtimeAlertsPublishable: true,
      alertsRequested: true,
      now: () => NOW,
      workerLease: { list: async () => healthyLeases() },
      liveCatalogWorker: fakeWorker('catalog', calls),
      realtimeAlertWorker: fakeWorker('alerts', calls),
      marketAggregateWorker: fakeWorker('aggregates', calls),
      marketAggregateOptions: { enabled: true },
    });

    assert.equal(sinks.start(), true);
    assert.deepEqual(calls, ['catalog:start', 'aggregates:start', 'alerts:start']);
    assert.deepEqual(await sinks.getRealtimeAlertRollout(), {
      alertsRequested: true, publishable: true,
    });
    await sinks.stop();
    assert.deepEqual(calls.slice(3).sort(), ['aggregates:stop', 'alerts:stop', 'catalog:stop']);
  });

  it('lets shadow mode win and fails alert publication closed on a health query error', async () => {
    const calls = [];
    const sinks = createRobinhoodDerivedLiveSinks({
      enabled: true,
      shadowAuditOnly: true,
      realtimeAlertsPublishable: true,
      alertsRequested: true,
      workerLease: { list: async () => { throw new Error('database unavailable'); } },
      liveCatalogWorker: fakeWorker('catalog', calls),
      realtimeAlertWorker: fakeWorker('alerts', calls),
      marketAggregateWorker: fakeWorker('aggregates', calls),
      marketAggregateOptions: { enabled: true },
    });

    assert.equal(sinks.start(), false);
    assert.deepEqual(calls, []);
    assert.deepEqual(await sinks.getRealtimeAlertRollout(), {
      alertsRequested: true, publishable: false,
    });
    assert.deepEqual(sinks.getStatus().health.blockers, ['health_query_failed']);
  });
});
