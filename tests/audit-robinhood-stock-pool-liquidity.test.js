'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const audit = require('../src/utils/audit-robinhood-stock-pool-liquidity');

describe('Robinhood stock pool liquidity audit', () => {
  it('parses bounded read-only endpoints and comparison total', () => {
    assert.deepEqual(audit.options([
      '--token-address=0x98096d17e191b3da1d5f99a6d7b3584351b11e18',
      '--archive-rpc-url=http://archive:8545', '--live-rpc-url=http://127.0.0.1:8547',
      '--range-size=2000000', '--expected-total-usd=2000000',
    ], {}), {
      tokenAddress: '0x98096d17e191b3da1d5f99a6d7b3584351b11e18',
      archiveRpcUrl: 'http://archive:8545', liveRpcUrl: 'http://127.0.0.1:8547',
      rangeSize: 2000000, expectedTotalUsd: '2000000',
    });
  });

  it('rejects an invalid token or unbounded scan range', () => {
    assert.throws(() => audit.options(['--token-address=nope'], {}), /token address is invalid/);
    assert.throws(() => audit.options(['--range-size=5000001'], {}), /range size must be/);
  });

  it('prices either currency orientation with exact fixed-point math', () => {
    const q96 = 1n << 96n;
    const base = {
      market_key: 'pool', token_address: 'token',
      currency0: 'token', currency1: 'quote',
    };
    assert.equal(audit.__private.quoteIndex(base), 1);
    assert.equal(audit.__private.tokenUsd('uniswap-v3', q96, base, 18, 18, '42'), '42');
    const inverted = { ...base, currency0: 'quote', currency1: 'token' };
    assert.equal(audit.__private.quoteIndex(inverted), 0);
    assert.equal(audit.__private.tokenUsd('uniswap-v4', q96, inverted, 18, 18, '42'), '42');
  });
});
