const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const planner = require('../src/services/coingecko-chart-backfill-plan');

const TOKEN_ADDRESS = '8wxkvAfEns76yBzu4MnbV7VnXWjg3iDPA9uwAQ6cpump';
const POOL_ADDRESS = 'Ak7hDCxDSocD2ZgJBCa1ZwLcuDQz5F6n747a7rQtpXE3';

function buildResult(candles = [
  { timestamp: 100, bucketTs: '2026-07-02T18:00:00.000Z', open: 0.1, high: 0.12, low: 0.09, close: 0.11, volume: 100 },
  { timestamp: 400, bucketTs: '2026-07-02T18:05:00.000Z', open: 0.11, high: 0.14, low: 0.1, close: 0.13, volume: 200 },
]) {
  return {
    poolAddress: POOL_ADDRESS,
    network: 'solana',
    timeframe: 'minute',
    aggregate: 5,
    requestedDays: 31,
    requestedFrom: '2026-07-02T18:00:00.000Z',
    requestedTo: '2026-07-02T18:05:00.000Z',
    calls: 1,
    candles,
  };
}

describe('CoinGecko chart backfill planner', () => {
  it('builds a dry-run plan with market-cap converted bucket preview', () => {
    const plan = planner.buildDryRunPlan({
      tokenAddress: TOKEN_ADDRESS,
      poolAddress: POOL_ADDRESS,
      catalogRow: {
        address: TOKEN_ADDRESS,
        symbol: 'SOLANGELES',
        name: 'SolAngeles',
        last_mcap: 130000,
      },
      result: buildResult(),
      existing: {
        tokenMarketBuckets1mRows: 12,
        tokenMarketBucketsAggRows: 6,
        tokenMarketBucketsAggRowsByGranularity: { 5: 2, 15: 2, 30: 2 },
      },
    });

    assert.equal(plan.mode, 'dry-run');
    assert.equal(plan.writes, false);
    assert.equal(plan.token.symbol, 'SOLANGELES');
    assert.equal(plan.request.from, '2026-07-02T18:00:00.000Z');
    assert.equal(plan.request.to, '2026-07-02T18:05:00.000Z');
    assert.equal(plan.coingecko.candles, 2);
    assert.equal(plan.mcapMultiplier.source, 'catalog_last_mcap_over_coingecko_latest_close');
    assert.equal(plan.mcapMultiplier.value, 1000000);
    assert.equal(plan.convertedBuckets.count, 2);
    assert.equal(plan.convertedBuckets.latest.closeMcap, 130000);
    assert.equal(plan.replaceImpact.targetTable, 'token_market_buckets_agg');
    assert.equal(plan.replaceImpact.targetGranularityMinutes, 5);
    assert.equal(plan.replaceImpact.wouldDeleteRows, 2);
    assert.equal(plan.replaceImpact.wouldInsertRows, 2);
    assert.equal(plan.readiness.canReplace, true);
  });

  it('reports gaps larger than the expected candle interval', () => {
    const gaps = planner.detectCandleGaps([
      { bucketTs: '2026-07-02T18:00:00.000Z' },
      { bucketTs: '2026-07-02T18:05:00.000Z' },
      { bucketTs: '2026-07-02T18:25:00.000Z' },
    ], 5);

    assert.equal(gaps.count, 1);
    assert.equal(gaps.maxMissingBuckets, 3);
    assert.deepEqual(gaps.samples[0], {
      from: '2026-07-02T18:05:00.000Z',
      to: '2026-07-02T18:25:00.000Z',
      deltaMinutes: 20,
      missingBuckets: 3,
    });
  });

  it('blocks replacement readiness when the market-cap multiplier is missing', () => {
    const plan = planner.buildDryRunPlan({
      tokenAddress: TOKEN_ADDRESS,
      poolAddress: POOL_ADDRESS,
      catalogRow: { address: TOKEN_ADDRESS, symbol: 'SOLANGELES' },
      result: buildResult(),
    });

    assert.equal(plan.mcapMultiplier.value, null);
    assert.equal(plan.convertedBuckets.latest.closeMcap, null);
    assert.equal(plan.readiness.canReplace, false);
    assert.deepEqual(plan.readiness.blockers, ['mcap_multiplier_missing']);
  });

  it('accepts a manual multiplier override', () => {
    const plan = planner.buildDryRunPlan({
      tokenAddress: TOKEN_ADDRESS,
      poolAddress: POOL_ADDRESS,
      result: buildResult(),
      mcapMultiplier: 2000000,
    });

    assert.equal(plan.mcapMultiplier.source, 'manual');
    assert.equal(plan.convertedBuckets.latest.closeMcap, 260000);
    assert.equal(plan.readiness.canReplace, true);
  });

  it('blocks only 1m imports that overlap the protected 14-day window', () => {
    const recentOneMinute = planner.buildDryRunPlan({
      tokenAddress: TOKEN_ADDRESS,
      poolAddress: POOL_ADDRESS,
      result: { ...buildResult(), aggregate: 1 },
      mcapMultiplier: 2000000,
      now: new Date('2026-07-02T19:00:00.000Z'),
    });
    const recentFiveMinute = planner.buildDryRunPlan({
      tokenAddress: TOKEN_ADDRESS,
      poolAddress: POOL_ADDRESS,
      result: buildResult(),
      mcapMultiplier: 2000000,
      now: new Date('2026-07-02T19:00:00.000Z'),
    });

    assert.equal(recentOneMinute.recentProtection.applies, true);
    assert.equal(recentOneMinute.readiness.canReplace, false);
    assert.ok(recentOneMinute.readiness.blockers.includes('protected_recent_1m_range'));
    assert.equal(recentFiveMinute.recentProtection.applies, false);
    assert.equal(recentFiveMinute.readiness.canReplace, true);
  });
});
