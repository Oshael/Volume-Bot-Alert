const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  __private,
} = require('../src/models/robinhood-holder-classification');

const TOKEN = `0x${'1'.repeat(40)}`;
const WALLET = `0x${'2'.repeat(40)}`;
const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;

function snapshot(overrides = {}) {
  return {
    tokenAddress: TOKEN, classifier: 'sniper', status: 'ready',
    statusReason: 'materialized', throughBlockNumber: '100', throughBlockHash: HASH_A,
    observedAt: '2026-08-21T12:00:00Z', records: [{
      walletAddress: WALLET, confidence: 'high', reasonCode: 'early_launch_buy',
      evidence: { deltaBlocks: 1 },
    }], ...overrides,
  };
}

describe('Robinhood holder classification persistence domain', () => {
  it('normalizes a complete ready snapshot and rejects incoherent records', () => {
    const normalized = __private.normalizeSnapshot(snapshot());
    assert.equal(normalized.state.classificationVersion, 'rh_holder_v1');
    assert.equal(normalized.records[0].throughBlockNumber, '100');
    assert.throws(() => __private.normalizeSnapshot(snapshot({ status: 'pending' })), /frontier/);
    assert.throws(() => __private.normalizeSnapshot(snapshot({
      status: 'pending', throughBlockNumber: null, throughBlockHash: null,
    })), /Only a ready/);
    assert.throws(() => __private.normalizeSnapshot(snapshot({ records: [{
      tokenAddress: `0x${'3'.repeat(40)}`, walletAddress: WALLET,
      confidence: 'high', reasonCode: 'early_launch_buy', evidence: { deltaBlocks: 1 },
    }] })), /token does not match/);
    assert.throws(() => __private.normalizeSnapshot(snapshot({ chain: 'ethereum' })), /chain/);
  });

  it('plans monotonic transitions and requires explicit fork or reset', () => {
    const current = __private.normalizeSnapshot(snapshot()).state;
    const ahead = __private.normalizeSnapshot(snapshot({
      throughBlockNumber: '101', throughBlockHash: HASH_B,
    })).state;
    const behind = __private.normalizeSnapshot(snapshot({
      throughBlockNumber: '99', throughBlockHash: HASH_B,
    })).state;
    const fork = __private.normalizeSnapshot(snapshot({ throughBlockHash: HASH_B })).state;
    const reset = __private.normalizeState({
      tokenAddress: TOKEN, classifier: 'sniper', status: 'unavailable',
      statusReason: 'source_unavailable', observedAt: '2026-08-21T13:00:00Z',
    });

    assert.equal(__private.planStateTransition(current, ahead), 'replace');
    assert.equal(__private.planStateTransition(current, behind), 'ignore');
    assert.throws(() => __private.planStateTransition(current, fork), /fork/);
    assert.equal(__private.planStateTransition(
      current, fork, { allowForkReplacement: true }
    ), 'replace');
    assert.throws(() => __private.planStateTransition(current, reset), /reset/);
    assert.equal(__private.planStateTransition(current, reset, { allowReset: true }), 'replace');
  });
});
