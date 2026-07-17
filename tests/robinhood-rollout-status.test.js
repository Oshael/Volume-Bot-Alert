const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildRobinhoodLeaseTelemetry,
  buildRobinhoodRolloutStatus,
  evaluateRobinhoodCatalogStagingGate,
  evaluateRobinhoodIngestionGate,
} = require('../src/services/robinhood-rollout-status');

const NOW_MS = Date.parse('2026-07-14T20:00:00.000Z');

function config(overrides = {}) {
  return {
    robinhoodIngestionWorker: { enabled: false },
    robinhoodSignalDryRun: {
      enabled: false,
      protocols: [],
      windowMs: null,
      minLiquidityUsd: null,
      minVolumeUsd: null,
      minTransactions: null,
      maxAgeMs: null,
    },
    ...overrides,
  };
}

describe('Robinhood rollout status', () => {
  it('requires master, transport and persistence gates before ingestion can start', () => {
    const inherited = evaluateRobinhoodIngestionGate(
      config({ robinhoodIngestionWorker: { enabled: true } })
    );
    const transportOff = evaluateRobinhoodIngestionGate(config({
      robinhoodIngestionWorker: { enabled: true },
      robinhoodRollout: {
        transport: { enabled: false, explicit: true },
        persistence: { enabled: true, explicit: true },
      },
    }));

    assert.equal(inherited.allowed, true);
    assert.deepEqual(inherited.blockers, []);
    assert.equal(transportOff.allowed, false);
    assert.deepEqual(transportOff.blockers, ['transport_disabled']);
  });

  it('requires explicit alert intent and ingestion axes before staging can start', () => {
    const alertsOff = evaluateRobinhoodCatalogStagingGate(config({
      robinhoodIngestionWorker: { enabled: true },
    }));
    const readyToWait = evaluateRobinhoodCatalogStagingGate(config({
      robinhoodIngestionWorker: { enabled: true },
      robinhoodSignalDryRun: {
        enabled: false,
        protocols: ['uniswap-v2'],
        windowMs: 300_000,
        minLiquidityUsd: '3000',
        minVolumeUsd: '1000',
        minTransactions: 10,
        maxAgeMs: 300_000,
      },
      robinhoodRollout: {
        transport: { enabled: true },
        persistence: { enabled: true },
        alerts: { requested: true },
      },
    }));

    assert.equal(alertsOff.allowed, false);
    assert.deepEqual(alertsOff.blockers, ['alerts_disabled', 'signal_gates_incomplete']);
    assert.equal(readyToWait.allowed, true);
    assert.equal(readyToWait.signalGatesConfigured, true);
    assert.deepEqual(readyToWait.blockers, []);

    const staleAge = evaluateRobinhoodCatalogStagingGate(config({
      robinhoodIngestionWorker: { enabled: true },
      robinhoodSignalDryRun: {
        enabled: true,
        protocols: ['uniswap-v2'],
        windowMs: 300_000,
        minLiquidityUsd: '3000',
        minVolumeUsd: '1000',
        minTransactions: 10,
        maxAgeMs: 300_001,
      },
      robinhoodRollout: {
        transport: { enabled: true },
        persistence: { enabled: true },
        alerts: { requested: true },
      },
    }));
    assert.equal(staleAge.signalGatesConfigured, false);
    assert.ok(staleAge.blockers.includes('signal_gates_incomplete'));
  });

  it('builds bounded shared telemetry with head, cursor, lag, provider and memory fields', () => {
    const telemetry = buildRobinhoodLeaseTelemetry({
      confirmations: 2,
      nowMs: NOW_MS,
      ingestionStatus: {
        running: true,
        lastCompletedAt: '2026-07-14T19:59:59.000Z',
        lastSnapshot: {
          coverage: {
            status: 'backfilling',
            caughtUp: false,
            unexplainedGaps: 0,
            discoveryCursor: '101',
            discoverySafeHead: '110',
            marketCursor: '91',
            marketSafeHead: '110',
            headProcessingDelayMs: 500,
          },
          runner: { cycles: 4, errors: 1, recoveries: 1, consecutiveErrors: 0 },
          rpc: {
            'robinhood-public': {
              requests: 12,
              errors: 1,
              fallbacks: 0,
              rateLimited: 2,
              requestBytes: 100,
              responseBytes: 200,
              errorCodes: { ignored: 999 },
            },
          },
          inMemoryState: {
            rollbackEnabled: false,
            rollbackLimit: 0,
            observations: 0,
            discoveries: 0,
            windowAggregationEnabled: false,
            windowEvents: 0,
            ignored: 'not-shared',
          },
        },
      },
    });

    assert.equal(telemetry.coverage.discovery.head, '112');
    assert.equal(telemetry.coverage.discovery.lagBlocks, 10);
    assert.equal(telemetry.coverage.market.lagBlocks, 20);
    assert.equal(telemetry.providers['robinhood-public'].rateLimited, 2);
    assert.equal(telemetry.transport.reconnectApplicable, false);
    assert.equal(Object.hasOwn(telemetry.providers['robinhood-public'], 'errorCodes'), false);
    assert.equal(Object.hasOwn(telemetry.inMemoryState, 'ignored'), false);
  });

  it('keeps shared head and cursor unavailable while the first poll is warming up', () => {
    const telemetry = buildRobinhoodLeaseTelemetry({
      nowMs: NOW_MS,
      ingestionStatus: { running: true, lastSnapshot: null },
    });
    const result = buildRobinhoodRolloutStatus({
      config: config({ robinhoodIngestionWorker: { enabled: true } }),
      sharedLease: {
        leaseUntil: '2026-07-14T20:01:00.000Z',
        metadata: { telemetry },
      },
      nowMs: NOW_MS,
    });

    assert.equal(telemetry.status, 'warming-up');
    assert.equal(result.health.telemetryScope, 'shared-worker-lease');
    assert.equal(result.health.headCursorAvailable, false);
    assert.equal(result.health.sharedHeadCursorAvailable, false);
  });

  it('reports the default rollout as fail-closed', () => {
    const result = buildRobinhoodRolloutStatus({ config: config(), nowMs: NOW_MS });

    assert.equal(result.phase, 'off');
    assert.equal(result.publishable, false);
    assert.equal(result.axes.transport.effective, false);
    assert.equal(result.axes.persistence.coupledToTransport, true);
    assert.equal(result.alertPublicationReady, true);
    assert.equal(result.axes.alerts.reason, 'ingestion_master_disabled');
    assert.deepEqual(result.axes.protocols.missingMandatory, []);
    assert.deepEqual(result.axes.protocols.allowlist, [
      'uniswap-v2', 'uniswap-v3', 'uniswap-v4',
    ]);
    assert.ok(result.blockers.includes('ingestion_master_disabled'));
    assert.ok(result.blockers.includes('alerts_disabled'));
  });

  it('reports explicit alert intent as blocked while ingestion and signal gates are unavailable', () => {
    const result = buildRobinhoodRolloutStatus({
      config: config({
        robinhoodIngestionWorker: { enabled: true },
        robinhoodRollout: {
          transport: { enabled: true, explicit: true },
          persistence: { enabled: true, explicit: true },
          alerts: { requested: true, explicit: true },
        },
      }),
      nowMs: NOW_MS,
    });

    assert.equal(result.axes.alerts.requested, true);
    assert.equal(result.axes.alerts.effective, false);
    assert.equal(result.axes.alerts.killSwitch, 'ROBINHOOD_ALERTS_ENABLED');
    assert.ok(result.publicationBlockers.includes('worker_not_active'));
    assert.ok(result.publicationBlockers.includes('signal_dry_run_disabled'));
  });

  it('treats the legacy protocol setting as informational for aggregate signals', () => {
    const result = buildRobinhoodRolloutStatus({
      config: config({
        robinhoodIngestionWorker: { enabled: true },
        robinhoodSignalDryRun: {
          enabled: true,
          protocols: ['uniswap-v2'],
          windowMs: 300_000,
          minLiquidityUsd: '3000',
          minVolumeUsd: '1000',
          minTransactions: 10,
          maxAgeMs: 300_000,
        },
      }),
      ingestionStatus: { running: false },
      sharedLease: {
        leaseUntil: '2026-07-14T20:01:00.000Z',
        metadata: {},
      },
      nowMs: NOW_MS,
    });

    assert.equal(result.phase, 'dry-run-ready');
    assert.equal(result.axes.transport.effective, true);
    assert.deepEqual(result.axes.protocols.allowlist, [
      'uniswap-v2', 'uniswap-v3', 'uniswap-v4',
    ]);
    assert.deepEqual(result.axes.protocols.requestedAllowlist, ['uniswap-v2']);
    assert.deepEqual(result.axes.protocols.missingMandatory, []);
    assert.equal(result.health.telemetryScope, 'remote-worker-lease-only');
    assert.equal(result.health.headCursorAvailable, false);
    assert.ok(result.blockers.includes('worker_metrics_process_local'));
    assert.equal(result.blockers.includes('mandatory_protocols_disabled'), false);
  });

  it('uses fresh lease telemetry for remote head and cursor observability', () => {
    const telemetry = buildRobinhoodLeaseTelemetry({
      nowMs: NOW_MS - 1000,
      ingestionStatus: {
        running: true,
        lastSnapshot: {
          coverage: {
            discoveryCursor: '101',
            discoverySafeHead: '101',
            marketCursor: '101',
            marketSafeHead: '101',
          },
        },
      },
    });
    const result = buildRobinhoodRolloutStatus({
      config: config({ robinhoodIngestionWorker: { enabled: true } }),
      sharedLease: {
        leaseUntil: '2026-07-14T20:01:00.000Z',
        metadata: { telemetry },
      },
      nowMs: NOW_MS,
    });

    assert.equal(result.health.telemetryScope, 'shared-worker-lease');
    assert.equal(result.health.headCursorAvailable, true);
    assert.equal(result.health.telemetryCapturedAt, '2026-07-14T19:59:59.000Z');
    assert.equal(result.telemetry.coverage.market.cursor, '101');
    assert.equal(result.blockers.includes('worker_metrics_process_local'), false);
  });

  it('allows caught-up aggregate alert delivery across all contribution protocols', () => {
    const result = buildRobinhoodRolloutStatus({
      config: config({
        robinhoodIngestionWorker: { enabled: true },
        robinhoodSignalDryRun: {
          enabled: true,
          protocols: ['uniswap-v2'],
          windowMs: 300_000,
          minLiquidityUsd: '3000',
          minVolumeUsd: '1000',
          minTransactions: 10,
          maxAgeMs: 300_000,
        },
        robinhoodRollout: {
          transport: { enabled: true },
          persistence: { enabled: true },
          alerts: { requested: true },
        },
      }),
      ingestionStatus: {
        running: true,
        lastSnapshot: {
          coverage: { caughtUp: true, unexplainedGaps: 0 },
        },
      },
      nowMs: NOW_MS,
    });

    assert.equal(result.publishable, true);
    assert.equal(result.phase, 'delivering-aggregate-alerts');
    assert.equal(result.axes.alerts.effective, true);
    assert.equal(result.axes.protocols.coverageComplete, true);
    assert.deepEqual(result.axes.protocols.missingMandatory, []);
    assert.equal(result.blockers.includes('mandatory_protocols_disabled'), false);
    assert.deepEqual(result.publicationBlockers, []);
  });

  it('promotes a durable fatal lease to the rollout phase', () => {
    const result = buildRobinhoodRolloutStatus({
      config: config({ robinhoodIngestionWorker: { enabled: true } }),
      sharedLease: {
        leaseUntil: '2026-07-14T20:01:00.000Z',
        metadata: { state: 'halted' },
      },
      nowMs: NOW_MS,
    });

    assert.equal(result.phase, 'halted');
    assert.equal(result.health.halted, true);
    assert.equal(result.health.sharedLeaseActive, false);
    assert.ok(result.blockers.includes('worker_halted'));
  });
});
