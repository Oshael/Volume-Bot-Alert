const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  ERROR_CODES,
  evaluateCustomAlertCapability,
  getCustomAlertCapability,
} = require('../src/services/custom-alert-capability-policy');

describe('custom alert capability policy', () => {
  it('publishes the frozen chain-specific spot capability matrix', () => {
    assert.deepEqual(getCustomAlertCapability({ chain: 'solana', ready: true }), {
      chain: 'solana',
      supported: true,
      ready: true,
      metrics: ['price', 'mcap'],
      windows: ['spot'],
      reason: null,
    });
    assert.deepEqual(getCustomAlertCapability({
      chain: 'robinhood', ready: false, reason: 'rollout_not_publishable',
    }), {
      chain: 'robinhood',
      supported: true,
      ready: false,
      metrics: ['price', 'fdv'],
      windows: ['spot'],
      reason: 'rollout_not_publishable',
    });
  });

  it('keeps known but unimplemented and unknown chains unsupported', () => {
    assert.deepEqual(getCustomAlertCapability({ chain: 'base', ready: true }), {
      chain: 'base', supported: false, ready: false,
      metrics: [], windows: [], reason: 'unsupported_chain',
    });
    assert.equal(getCustomAlertCapability({ chain: 'future-chain', ready: true }).chain, null);
  });

  const acceptedCases = [
    ['Solana price', { chain: 'solana', metric: 'price', window: 'spot', ready: true }],
    ['Solana MCAP legacy window', { chain: 'solana', metric: 'MCAP', ready: true }],
    ['Robinhood price', { chain: 'robinhood', metric: 'price', window: 'spot', ready: true }],
    ['Robinhood FDV', { chain: 'robinhood', metric: 'FDV', window: 'SPOT', ready: true }],
  ];
  for (const [name, input] of acceptedCases) {
    it(`accepts ${name}`, () => {
      const result = evaluateCustomAlertCapability(input);
      assert.equal(result.ok, true);
      assert.equal(result.window, 'spot');
      assert.equal(result.metric, String(input.metric).toLowerCase());
      assert.equal(result.legacyWindowDefaulted, input.window == null);
    });
  }

  const rejectedCases = [
    ['Robinhood MCAP', { chain: 'robinhood', metric: 'mcap', ready: true }, ERROR_CODES.metricUnsupported],
    ['Solana FDV', { chain: 'solana', metric: 'fdv', ready: true }, ERROR_CODES.metricUnsupported],
    ['Robinhood rolling window', { chain: 'robinhood', metric: 'fdv', window: '5m', ready: true }, ERROR_CODES.windowUnsupported],
    ['Base price', { chain: 'base', metric: 'price', ready: true }, ERROR_CODES.chainUnsupported],
    ['missing chain with EVM address', {
      address: '0x1234567890abcdef1234567890abcdef12345678', metric: 'price', ready: true,
    }, ERROR_CODES.chainUnsupported],
  ];
  for (const [name, input, code] of rejectedCases) {
    it(`rejects ${name}`, () => {
      const result = evaluateCustomAlertCapability(input);
      assert.equal(result.ok, false);
      assert.equal(result.code, code);
    });
  }

  it('distinguishes supported-but-blocked readiness from unsupported metrics', () => {
    const blocked = evaluateCustomAlertCapability({
      chain: 'robinhood', metric: 'fdv', window: 'spot',
      ready: false, reason: 'rollout_not_publishable',
    });
    assert.equal(blocked.code, ERROR_CODES.notReady);
    assert.equal(blocked.reason, 'rollout_not_publishable');
    assert.equal(blocked.capability.supported, true);

    const mismatched = evaluateCustomAlertCapability({
      chain: 'robinhood', metric: 'mcap', window: 'spot',
      ready: false, reason: 'rollout_not_publishable',
    });
    assert.equal(mismatched.code, ERROR_CODES.metricUnsupported);
  });
});
