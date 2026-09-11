'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CHANNEL, MAX_PAYLOAD_BYTES, POINTER_TYPE, createMarketLiquidityRealtime,
} = require('../src/services/market-liquidity-realtime');
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
test('liquidity relay publishes a bounded durable pointer and keeps audience opt-in', async () => {
  const calls = []; let connects = 0;
  const relay = createMarketLiquidityRealtime({
    database: { query: async (...args) => calls.push(args) },
    pool: { connect: async () => { connects += 1; } },
  });
  const pools = Array.from({ length: 100 }, (_, index) => ({
    protocol: 'uniswap-v3', marketKey: `robinhood:uniswap-v3:pool-${index}`,
    poolAddress: `0x${index.toString(16).padStart(40, '0')}`, poolId: null,
    liquidityUsd: '42.5',
  }));
  const oversizedEvent = event({
    liquidityUsd: '4250', liquidityMarketCount: 100,
    valuedLiquidityMarketCount: 100, liquidityPools: pools,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(oversizedEvent), 'utf8') > MAX_PAYLOAD_BYTES);
  assert.equal(await relay.publish(oversizedEvent), true);
  const published = calls[0][1][1];
  assert.deepEqual(JSON.parse(published), {
    type: POINTER_TYPE, chain: 'robinhood', address: `0x${'1'.repeat(40)}`,
    liquidityProjectionCommittedAt: '2026-09-11T19:00:00.000Z',
  });
  assert.ok(Buffer.byteLength(published, 'utf8') < MAX_PAYLOAD_BYTES);
  await assert.rejects(relay.publish(event({ liquidityMarketCount: -1 })), /invalid or oversized/);
  await relay.start();
  assert.deepEqual([connects, relay.getStatus().audienceEnabled], [0, false]);
});
test('enabled liquidity audience remains compatible with full rolling-deploy events', () => {
  const emitted = [];
  const relay = createMarketLiquidityRealtime({
    audienceEnabled: true, now: () => Date.parse('2026-09-11T19:00:00.250Z'),
    socketHub: { emitMarketLiquidityUpdate: (value) => emitted.push(value) },
  });
  const received = relay.handleNotification({ channel: CHANNEL, payload: JSON.stringify(event()) });
  assert.deepEqual([received.liquidityUsd, received.latency.publishedAt, emitted.length,
    relay.getStatus().received], [42.5, '2026-09-11T19:00:00.250Z', 1, 1]);
});

test('enabled liquidity audience hydrates a durable pointer before socket delivery', async () => {
  const emitted = []; const reads = [];
  const relay = createMarketLiquidityRealtime({
    audienceEnabled: true, now: () => Date.parse('2026-09-11T19:00:00.250Z'),
    projectionRepository: { async readProjection(pointer) {
      reads.push(pointer);
      return event({ liquidityProjectionCommittedAt: pointer.liquidityProjectionCommittedAt });
    } },
    socketHub: { emitMarketLiquidityUpdate: (value) => emitted.push(value) },
  });
  const pointer = {
    type: POINTER_TYPE, chain: 'robinhood', address: `0x${'1'.repeat(40)}`,
    liquidityProjectionCommittedAt: '2026-09-11T19:00:00.000Z',
  };
  await relay.handleNotification({ channel: CHANNEL, payload: JSON.stringify(pointer) });
  assert.deepEqual(reads, [pointer]);
  assert.deepEqual([emitted[0].liquidityUsd, relay.getStatus().notifications,
    relay.getStatus().hydrationFailures], [42.5, 1, 0]);
});

test('liquidity audience coalesces a same-token pointer burst at the newest version', async () => {
  const reads = [];
  const relay = createMarketLiquidityRealtime({
    audienceEnabled: true,
    projectionRepository: { async readProjection(pointer) {
      reads.push(pointer.liquidityProjectionCommittedAt); return event();
    } },
    socketHub: { emitMarketLiquidityUpdate() {} },
  });
  const pointer = { type: POINTER_TYPE, chain: 'robinhood', address: `0x${'1'.repeat(40)}` };
  await Promise.all([
    relay.handleNotification({ channel: CHANNEL, payload: JSON.stringify({
      ...pointer, liquidityProjectionCommittedAt: '2026-09-11T18:59:59.000Z',
    }) }),
    relay.handleNotification({ channel: CHANNEL, payload: JSON.stringify({
      ...pointer, liquidityProjectionCommittedAt: '2026-09-11T19:00:00.000Z',
    }) }),
  ]);
  assert.deepEqual(reads, ['2026-09-11T19:00:00.000Z']);
});
