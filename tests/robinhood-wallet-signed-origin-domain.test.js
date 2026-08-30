const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  comparePosition,
  inferPriorSignedActivity,
} = require('../src/services/robinhood-wallet-signed-origin-domain');

function input(overrides = {}) {
  return {
    cutoffBlock: '110',
    coverage: { originBlock: '100', throughBlock: '130' },
    firstBuy: { blockNumber: '120', transactionIndex: '4' },
    signedOrigin: { blockNumber: '120', transactionIndex: '4', nonce: '0' },
    ...overrides,
  };
}

describe('Robinhood wallet signed origin domain', () => {
  it('orders transaction positions without unsafe number coercion', () => {
    assert.equal(comparePosition(
      { blockNumber: 10n, transactionIndex: 2n },
      { blockNumber: 10n, transactionIndex: 3n }
    ), -1);
    assert.equal(comparePosition(
      { blockNumber: 11n, transactionIndex: 0n },
      { blockNumber: 10n, transactionIndex: 99n }
    ), 1);
  });

  it('uses nonce zero position to decide activity at the cutoff boundary', () => {
    assert.deepEqual(inferPriorSignedActivity(input({
      signedOrigin: { blockNumber: '110', transactionIndex: '8', nonce: '0' },
    })), {
      status: 'ready', priorSignedActivity: true, reason: 'signed_at_or_before_cutoff',
    });
    assert.deepEqual(inferPriorSignedActivity(input()), {
      status: 'ready', priorSignedActivity: false,
      reason: 'no_signed_activity_before_cutoff',
    });
  });

  it('treats a positive first observed nonce as activity before coverage origin', () => {
    assert.deepEqual(inferPriorSignedActivity(input({
      signedOrigin: { blockNumber: '120', transactionIndex: '4', nonce: '7' },
    })), {
      status: 'ready', priorSignedActivity: true, reason: 'positive_initial_nonce',
    });
  });

  it('fails closed for incomplete coverage and impossible signed origins', () => {
    const cases = [
      [input({ coverage: { originBlock: '111', throughBlock: '130' } }),
        'coverage_starts_after_cutoff'],
      [input({ coverage: { originBlock: '100', throughBlock: '119' } }),
        'coverage_incomplete'],
      [input({ signedOrigin: null }), 'signed_origin_missing'],
      [input({ signedOrigin: { blockNumber: '99', transactionIndex: '0', nonce: '0' } }),
        'signed_origin_outside_coverage'],
      [input({ signedOrigin: { blockNumber: '120', transactionIndex: '5', nonce: '0' } }),
        'signed_origin_after_first_buy'],
    ];
    for (const [value, reason] of cases) {
      assert.deepEqual(inferPriorSignedActivity(value), {
        status: 'unavailable', priorSignedActivity: null, reason,
      });
    }
  });

  it('rejects malformed positions and a cutoff after the first buy', () => {
    assert.throws(() => inferPriorSignedActivity(input({ cutoffBlock: '121' })),
      /cutoffBlock must not follow/);
    assert.throws(() => inferPriorSignedActivity(input({
      signedOrigin: { blockNumber: '120', transactionIndex: '-1', nonce: '0' },
    })), /signedOrigin.transactionIndex/);
  });
});
