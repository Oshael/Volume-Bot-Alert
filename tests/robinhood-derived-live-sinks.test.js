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

function healthyCanonicalLeases() {
  return [
    {
      key: 'robinhood-chain-capture-worker',
      leaseUntil: new Date(NOW + 60_000).toISOString(),
      metadata: {
        running: true, lagBlocks: 0, lastError: null,
        nodeHeadObservedAt: new Date(NOW - 1000).toISOString(),
      },
    },
    {
      key: 'robinhood-canonical-head-worker',
      leaseUntil: new Date(NOW + 60_000).toISOString(),
      metadata: {
        mode: 'canonical_publish', running: true, lastError: null,
        lastTickAt: new Date(NOW - 1000).toISOString(),
        canonicalRuntime: { rpcGuard: { forbiddenAttempts: 0 } },
      },
    },
    healthyLeases()[1],
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
      evaluateDerivedPipelineHealth(unhealthy, {
        nowMs: NOW,
        processingBacklog: {
          blockNumber: '100', observedAt: new Date(NOW - 120_000).toISOString(),
        },
      }).blockers,
      ['head_telemetry_stale', 'processing_blocked', 'processing_backlog_stale']
    );
  });

  it('accepts only an exclusive healthy canonical publisher as head authority', () => {
    assert.deepEqual(
      evaluateDerivedPipelineHealth(healthyCanonicalLeases(), { nowMs: NOW }),
      { ready: true, blockers: [] }
    );
    const conflicting = [...healthyCanonicalLeases(), healthyLeases()[0]];
    assert.deepEqual(
      evaluateDerivedPipelineHealth(conflicting, { nowMs: NOW }).blockers,
      ['head_writer_conflict']
    );
    const monolithConflict = [...healthyCanonicalLeases(), {
      key: 'robinhood-ingestion-worker',
      leaseUntil: new Date(NOW + 60_000).toISOString(), metadata: {},
    }];
    assert.deepEqual(
      evaluateDerivedPipelineHealth(monolithConflict, { nowMs: NOW }).blockers,
      ['head_writer_conflict']
    );
    const missingLag = healthyCanonicalLeases();
    delete missingLag[0].metadata.lagBlocks;
    assert.deepEqual(
      evaluateDerivedPipelineHealth(missingLag, { nowMs: NOW }).blockers,
      ['capture_lag_missing']
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
      processingRepository: { getOldestActiveCapture: async () => null },
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
      processingRepository: { getOldestActiveCapture: async () => null },
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
