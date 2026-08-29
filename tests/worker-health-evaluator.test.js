'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  getWorkerHealthDefinition,
  listWorkerHealthDefinitions,
} = require('../src/services/worker-health-registry');
const { evaluateWorkerHealth } = require('../src/services/worker-health-evaluator');

const NOW = Date.parse('2026-08-29T12:00:00.000Z');

function lease(metadata, overrides = {}) {
  return {
    acquiredAt: '2026-08-29T11:55:00.000Z',
    leaseUntil: '2026-08-29T12:02:00.000Z',
    metadata,
    ...overrides,
  };
}

function codes(issues) {
  return issues.map(({ code }) => code);
}

describe('worker health registry', () => {
  it('registers every current durable worker lease exactly once', () => {
    const definitions = listWorkerHealthDefinitions();
    assert.equal(definitions.length, 51);
    assert.equal(new Set(definitions.map(({ key }) => key)).size, 51);
    assert.equal(getWorkerHealthDefinition('callout-capture-worker').group, 'callouts');
    assert.deepEqual(getWorkerHealthDefinition('robinhood-catalog-projection-worker').groups,
      ['robinhood-derived', 'robinhood']);
    assert.equal(getWorkerHealthDefinition('robinhood-pool-liquidity-worker').profile, 'live');
    assert.equal(getWorkerHealthDefinition('web-realtime-runtime').group, 'web');
    assert.equal(getWorkerHealthDefinition('core-support-runtime').profile, 'maintenance');
    assert.equal(getWorkerHealthDefinition('robinhood-holder-live-worker')
      .thresholds.maxInFlightMs, 600_000);
    assert.equal(getWorkerHealthDefinition('robinhood-wallet-transfer-backfill-worker').profile,
      'maintenance');
    assert.equal(getWorkerHealthDefinition('unknown-worker'), null);
  });
});

describe('worker health evaluator', () => {
  const definition = getWorkerHealthDefinition('robinhood-ingestion-worker');

  it('alerts only when a missing lease is expected', () => {
    assert.deepEqual(evaluateWorkerHealth(definition, null), []);
    assert.deepEqual(codes(evaluateWorkerHealth(definition, null, { expected: true })), [
      'lease_missing',
    ]);
  });

  it('detects expired, halted and telemetry-failing leases', () => {
    const issues = evaluateWorkerHealth(definition, lease({
      state: 'halted',
      metadataProviderError: { message: 'snapshot failed' },
      telemetry: { running: true, lastCompletedAt: '2026-08-29T11:59:30.000Z' },
    }, { leaseUntil: '2026-08-29T11:59:59.000Z' }), { nowMs: NOW, expected: true });
    assert.deepEqual(codes(issues), ['lease_expired', 'lease_halted', 'telemetry_error']);
  });

  it('accepts a healthy running worker', () => {
    const issues = evaluateWorkerHealth(definition, lease({ telemetry: {
      enabled: true, running: true, inFlight: false, consecutiveErrors: 0,
      lastCompletedAt: '2026-08-29T11:59:30.000Z', lagBlocks: 2,
    } }), { nowMs: NOW, expected: true });
    assert.deepEqual(issues, []);
  });

  it('detects stopped, unhealthy and disconnected nested components', () => {
    const callouts = getWorkerHealthDefinition('callout-capture-worker');
    const issues = evaluateWorkerHealth(callouts, lease({ telemetry: {
      running: true,
      pump: { running: false },
      fomo: { running: true, connected: false },
      fomoHealth: { running: true, healthy: false },
      lastCompletedAt: '2026-08-29T11:59:30.000Z',
    } }), { nowMs: NOW });
    assert.deepEqual(codes(issues), [
      'component_stopped', 'component_disconnected', 'component_unhealthy',
    ]);
    assert.equal(issues[0].id, 'callout-capture-worker:telemetry.pump:component_stopped');
  });

  it('detects errors, stuck execution, lag, loop overrun and backlog', () => {
    const issues = evaluateWorkerHealth(definition, lease({ telemetry: {
      enabled: true, running: true, inFlight: true,
      lastRunAt: '2026-08-29T11:55:00.000Z',
      consecutiveErrors: 3, lastError: { code: 'timeout' },
      lagBlocks: 51, lagMs: 60_001, lastLoopOverrunMs: 30_001, depth: 1_001,
    } }), { nowMs: NOW });
    assert.deepEqual(codes(issues), [
      'active_error', 'execution_stalled', 'lag_blocks_high',
      'lag_time_high', 'loop_overrun', 'queue_backlog',
    ]);
  });

  it('does not mistake a cumulative queued counter for current backlog', () => {
    const issues = evaluateWorkerHealth(definition, lease({ telemetry: {
      running: true, lastCompletedAt: '2026-08-29T11:59:30.000Z',
      queued: 50_000, processed: 49_999, pending: 1,
    } }), { nowMs: NOW });

    assert.deepEqual(issues, []);
  });

  it('records the concrete process group reported by the lease', () => {
    const tokenRisk = getWorkerHealthDefinition('token-risk-enrichment-worker');
    const issues = evaluateWorkerHealth(tokenRisk, lease({
      group: 'core',
      telemetry: { running: true, consecutiveErrors: 3, lastError: 'provider failed' },
    }), { nowMs: NOW });

    assert.equal(issues.find(({ code }) => code === 'active_error').runtimeGroup, 'core');
  });

  it('detects stale progress and startup without a first successful cycle', () => {
    const stale = evaluateWorkerHealth(definition, lease({ telemetry: {
      running: true, lastCompletedAt: '2026-08-29T11:56:00.000Z',
    } }), { nowMs: NOW });
    assert.deepEqual(codes(stale), ['progress_stale']);

    const startup = evaluateWorkerHealth(definition, lease({ telemetry: {
      running: true, inFlight: false, lastCompletedAt: null,
    } }, {
      acquiredAt: '2026-08-29T11:55:00.000Z',
    }), { nowMs: NOW });
    assert.deepEqual(codes(startup), ['startup_stalled']);
  });

  it('ignores stale optional leases and telemetry gaps during startup grace', () => {
    const staleOptional = evaluateWorkerHealth(definition, lease({ telemetry: null }, {
      leaseUntil: '2026-08-29T11:00:00.000Z',
    }), { nowMs: NOW, expected: false });
    assert.deepEqual(staleOptional, []);

    const starting = evaluateWorkerHealth(definition, lease({}, {
      acquiredAt: '2026-08-29T11:59:00.000Z',
    }), { nowMs: NOW, expected: true });
    assert.deepEqual(starting, []);
  });

  it('accepts scheduled idle components and their declared cadence', () => {
    const callouts = getWorkerHealthDefinition('callout-capture-worker');
    const issues = evaluateWorkerHealth(callouts, lease({ telemetry: {
      running: true,
      fomoFollow: { enabled: true, running: false, nextRunAt: '2026-08-29T12:03:00.000Z' },
      retention: {
        enabled: true, running: true, intervalMs: 300_000,
        lastCompletedAt: '2026-08-29T11:56:00.000Z',
      },
    } }), { nowMs: NOW, expected: true });
    assert.deepEqual(issues, []);
  });

  it('supports the dedicated liquidity worker metadata shape', () => {
    const liquidity = getWorkerHealthDefinition('robinhood-pool-liquidity-worker');
    const issues = evaluateWorkerHealth(liquidity, lease({
      running: true, polling: false, lagBlocks: 1,
    }), { nowMs: NOW });
    assert.deepEqual(issues, []);
  });

  it('detects process memory, event-loop and disk pressure once requested', () => {
    const issues = evaluateWorkerHealth(definition, lease({
      telemetry: { running: true, lastCompletedAt: '2026-08-29T11:59:30.000Z' },
      runtime: {
        rssBytes: 2_000, heapUsedPercent: 95, eventLoopP99Ms: 700,
        disk: { freePercent: 4, freeBytes: 400 },
      },
    }), {
      nowMs: NOW, evaluateRuntime: true,
      runtimeThresholds: {
        maxRssBytes: 1_000, maxHeapPercent: 90, maxEventLoopP99Ms: 500,
        minDiskFreePercent: 5, minDiskFreeBytes: 500,
      },
    });
    assert.deepEqual(codes(issues), [
      'process_memory_high', 'process_heap_high', 'event_loop_lag_high', 'disk_space_low',
    ]);
  });
});
