'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { CHANNEL, createMarketLiquidityRealtime } = require('../src/services/market-liquidity-realtime');
function event(overrides = {}) {
  return {
    chain: 'robinhood', address: `0x${'1'.repeat(40)}`, liquidityUsd: '42.5',
    liquidityProjectionCommittedAt: '2026-09-11T19:00:00.000Z',
    liquidityCoverage: 'complete', liquidityMarketCount: 1,
    valuedLiquidityMarketCount: 1, liquidityPools: [{
      protocol: 'uniswap-v3', marketKey: 'robinhood:uniswap-v3:pool',
      poolAddress: `0x${'2'.repeat(40)}`, poolId: null, liquidityUsd: '42.5',
    }], latency: { projectionCommittedAt: '2026-09-11T19:00:00.000Z' }, ...overrides,
  };
}
test('liquidity relay validates before publishing and keeps audience opt-in', async () => {
  const calls = []; let connects = 0;
  const relay = createMarketLiquidityRealtime({
    database: { query: async (...args) => calls.push(args) },
    pool: { connect: async () => { connects += 1; } },
  });
  assert.equal(await relay.publish(event()), true);
  assert.equal(JSON.parse(calls[0][1][1]).type, 'market:liquidity');
  await assert.rejects(relay.publish(event({ liquidityMarketCount: -1 })), /invalid or oversized/);
  await relay.start();
  assert.deepEqual([connects, relay.getStatus().audienceEnabled], [0, false]);
});
test('enabled liquidity audience forwards a normalized event with publish latency', () => {
  const emitted = [];
  const relay = createMarketLiquidityRealtime({
    audienceEnabled: true, now: () => Date.parse('2026-09-11T19:00:00.250Z'),
    socketHub: { emitMarketLiquidityUpdate: (value) => emitted.push(value) },
  });
  const received = relay.handleNotification({ channel: CHANNEL, payload: JSON.stringify(event()) });
  assert.deepEqual([received.liquidityUsd, received.latency.publishedAt, emitted.length,
    relay.getStatus().received], [42.5, '2026-09-11T19:00:00.250Z', 1, 1]);
});
