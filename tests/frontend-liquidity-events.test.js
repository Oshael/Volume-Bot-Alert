const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');
const esbuild = require('../frontend/node_modules/esbuild');

const TOKEN = `0x${'1'.repeat(40)}`;
const POOL = `0x${'2'.repeat(40)}`;
let liquidityEvents;

before(async () => {
  const result = await esbuild.build({
    entryPoints: ['frontend/src/services/socket/liquidity-events.ts'],
    bundle: true, format: 'esm', platform: 'node', write: false,
  });
  const source = Buffer.from(result.outputFiles[0].text).toString('base64');
  liquidityEvents = await import(`data:text/javascript;base64,${source}`);
});

function event(overrides = {}) {
  return {
    type: 'market:liquidity', chain: 'robinhood', address: TOKEN.toUpperCase(),
    liquidityUsd: '42.5', liquidityProjectionCommittedAt: '2026-09-11T19:00:00.200Z',
    liquidityCoverage: 'partial', liquidityMarketCount: 2,
    valuedLiquidityMarketCount: 1, liquidityIsLowerBound: true,
    liquidityPools: [{
      protocol: 'uniswap-v3', marketKey: `robinhood:uniswap-v3:${POOL}`,
      poolAddress: POOL.toUpperCase(), poolId: null, liquidityUsd: '42.5',
    }], latency: { publishedAt: '2026-09-11T19:00:00.300Z' }, ...overrides,
  };
}

describe('frontend liquidity realtime events', () => {
  it('normalizes the HTTP-compatible projection and browser receipt mark', () => {
    const normalized = liquidityEvents.normalizeMarketLiquidityUpdate(event());
    assert.deepEqual({
      address: normalized.address, liquidityUsd: normalized.liquidityUsd,
      coverage: normalized.liquidityCoverage, lowerBound: normalized.liquidityIsLowerBound,
      poolAddress: normalized.liquidityPools[0].poolAddress,
    }, { address: TOKEN, liquidityUsd: 42.5, coverage: 'partial',
      lowerBound: true, poolAddress: POOL });
    assert.equal(liquidityEvents.markMarketLiquidityReceived(
      normalized, Date.parse('2026-09-11T19:00:00.350Z'),
    ).latency.clientReceivedAt, '2026-09-11T19:00:00.350Z');
  });

  it('rejects malformed identity, coverage, version and pool evidence', () => {
    for (const malformed of [
      event({ chain: 'base' }), event({ liquidityProjectionCommittedAt: 'bad' }),
      event({ type: 'market:bucket' }),
      event({ valuedLiquidityMarketCount: 2 }), event({ liquidityCoverage: 'unavailable' }),
      event({ liquidityPools: [{ ...event().liquidityPools[0], poolAddress: 'bad' }] }),
    ]) assert.equal(liquidityEvents.normalizeMarketLiquidityUpdate(malformed), null);
  });

  it('applies only a strictly newer durable projection', () => {
    const current = {
      chain: 'robinhood', address: TOKEN, label: 'unchanged', liquidityUsd: 10,
      liquidityProjectionCommittedAt: '2026-09-11T19:00:00.100Z',
    };
    const newer = liquidityEvents.normalizeMarketLiquidityUpdate(event());
    const applied = liquidityEvents.applyLiquidityProjection(current, newer);
    assert.equal(applied.liquidityUsd, 42.5);
    assert.equal(applied.label, 'unchanged');
    assert.equal(liquidityEvents.applyLiquidityProjection(applied, newer), null);
    assert.equal(liquidityEvents.applyLiquidityProjection(applied,
      liquidityEvents.normalizeMarketLiquidityUpdate(event({
        liquidityProjectionCommittedAt: '2026-09-11T19:00:00.050Z',
      }))), null);
    assert.equal(liquidityEvents.newestLiquidityProjection(current, applied), applied);
  });
});
