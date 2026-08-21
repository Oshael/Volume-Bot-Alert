const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  __private,
} = require('../src/models/robinhood-holder-distribution-metric');

const TOKEN = `0x${'1'.repeat(40)}`;
const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;

function snapshot(overrides = {}) {
  return {
    tokenAddress: TOKEN, metric: 'dev_hold', status: 'ready',
    statusReason: 'materialized', valueNumeratorRaw: '25', valueDenominatorRaw: '100',
    walletCount: '1', evidence: { source: 'ledger' }, throughBlockNumber: '100',
    throughBlockHash: HASH_A, observedAt: '2026-08-21T12:00:00Z', ...overrides,
  };
}

describe('Robinhood holder distribution metric persistence domain', () => {
  it('enforces exact payloads and monotonic frontiers', () => {
    const current = __private.normalizeSnapshot(snapshot());
    assert.equal(current.valueNumeratorRaw, '25');
    assert.equal(__private.planTransition(current, snapshot({
      observedAt: '2026-08-21T12:05:00Z',
    })), 'unchanged');
    assert.equal(__private.planTransition(current, snapshot({
      throughBlockNumber: '101', throughBlockHash: HASH_B,
    })), 'replace');
    assert.equal(__private.planTransition(current, snapshot({
      throughBlockNumber: '99', throughBlockHash: HASH_B,
    })), 'ignore');
    assert.throws(() => __private.planTransition(current, snapshot({
      throughBlockHash: HASH_B,
    })), /fork/);
    assert.throws(() => __private.normalizeSnapshot(snapshot({
      valueNumeratorRaw: '101',
    })), /valid ratio/);
    assert.throws(() => __private.normalizeSnapshot(snapshot({
      status: 'unavailable', throughBlockNumber: null, throughBlockHash: null,
    })), /cannot publish values/);
    assert.throws(() => __private.planTransition(current, snapshot({ metric: 'top10' })),
      /different metric/);
  });
});
