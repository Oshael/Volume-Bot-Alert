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
    assert.equal(definitions.length, 48);
    assert.equal(new Set(definitions.map(({ key }) => key)).size, 48);
    assert.equal(getWorkerHealthDefinition('callout-capture-worker').group, 'callouts');
    assert.deepEqual(getWorkerHealthDefinition('robinhood-catalog-projection-worker').groups,
      ['robinhood-derived', 'robinhood']);
    assert.equal(getWorkerHealthDefinition('robinhood-pool-liquidity-worker').profile, 'live');
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
    }, { leaseUntil: '2026-08-29T11:59:59.000Z' }), { nowMs: NOW });
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
      lagBlocks: 51, lagMs: 60_001, lastLoopOverrunMs: 30_001, queued: 1_001,
    } }), { nowMs: NOW });
    assert.deepEqual(codes(issues), [
      'consecutive_errors', 'active_error', 'execution_stalled', 'lag_blocks_high',
      'lag_time_high', 'loop_overrun', 'queue_backlog',
    ]);
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

  it('supports the dedicated liquidity worker metadata shape', () => {
    const liquidity = getWorkerHealthDefinition('robinhood-pool-liquidity-worker');
    const issues = evaluateWorkerHealth(liquidity, lease({
      running: true, polling: false, lagBlocks: 1,
    }), { nowMs: NOW });
    assert.deepEqual(issues, []);
  });
});
