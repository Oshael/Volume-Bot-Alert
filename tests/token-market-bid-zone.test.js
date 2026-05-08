const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const tokenMarketBucket1m = require('../src/models/token-market-bucket-1m');

describe('token market bid-zone helpers', () => {
  it('requires longer minimum windows for larger market caps', () => {
    assert.equal(tokenMarketBucket1m.__private.getMinimumWindowHoursForMcap(250000), 16);
    assert.equal(tokenMarketBucket1m.__private.getMinimumWindowHoursForMcap(1000000), 32);
    assert.equal(tokenMarketBucket1m.__private.getMinimumWindowHoursForMcap(7500000), 32);
  });

  it('applies bounded scan limits and statement timeouts to heavy bid-zone queries', async () => {
    const originalQueryWithStatementTimeout = db.queryWithStatementTimeout;
    const calls = [];
    db.queryWithStatementTimeout = async (sql, params, timeoutMs) => {
      calls.push({ sql, params, timeoutMs });
      return { rows: [] };
    };

    try {
      await tokenMarketBucket1m.computeBidZoneCandidates({
        candidateScanLimit: 85,
        statementTimeoutMs: 10000,
      });

      assert.equal(calls.length, 1);
      assert.match(calls[0].sql, /WITH active_candidates AS/i);
      assert.match(calls[0].sql, /LIMIT \$7::bigint/i);
      assert.equal(calls[0].params[6], 85);
      assert.equal(calls[0].timeoutMs, 10000);
    } finally {
      db.queryWithStatementTimeout = originalQueryWithStatementTimeout;
    }
  });

  it('scores a supported compressed candidate as a passing bid-zone candidate', () => {
    const scored = tokenMarketBucket1m.__private.scoreBidZoneCandidate({
      last_mcap: 240000,
      last_mcap_window: 242000,
      support_level_mcap: 225000,
      resistance_level_mcap: 270000,
      median_close_mcap: 246000,
      first_close_mcap: 236000,
      recent_median_close_mcap: 244000,
      recent_range_pct: 12,
      support_touch_clusters: 4,
      last_vol_1h: 12000,
      last_vol_6h: 44000,
      last_vol_24h: 95000,
      bucket_count: 590,
      sample_count: 1100,
      last_token_created_at_ms: Date.now() - (10 * 60 * 60 * 1000),
    }, {
      hours: 48,
      minMcap: 90000,
      minVol1h: 1000,
      minCoverageRatio: 0.7,
      minBuckets: 20,
      minVol24h: 10000,
      nowMs: Date.now(),
    });

    assert.equal(scored.passes, true);
    assert.ok((scored.score || 0) > 50);
  });

  it('applies stronger 1h-volume penalties to very thin candidates', () => {
    assert.equal(tokenMarketBucket1m.__private.getLiquidityRankingAdjustment(100, 200), -12);
    assert.equal(tokenMarketBucket1m.__private.getLiquidityRankingAdjustment(150, 6000), -12);
    assert.equal(tokenMarketBucket1m.__private.getLiquidityRankingAdjustment(400, 400), -7);
    assert.equal(tokenMarketBucket1m.__private.getLiquidityRankingAdjustment(400, 4000), -4);
    assert.equal(tokenMarketBucket1m.__private.getLiquidityRankingAdjustment(400, 4000, { ageHours: 24 * 20 }), -6);
    assert.equal(tokenMarketBucket1m.__private.getLiquidityRankingAdjustment(400, 4000, { ageHours: 24 * 40 }), -8);
    assert.equal(tokenMarketBucket1m.__private.getLiquidityRankingAdjustment(1200, 1200), 0);
  });

  it('keeps the dead-liquidity filter narrow', () => {
    assert.equal(tokenMarketBucket1m.__private.passesDeadLiquidityFilter(90, 1400), false);
    assert.equal(tokenMarketBucket1m.__private.passesDeadLiquidityFilter(90, 2000), true);
    assert.equal(tokenMarketBucket1m.__private.passesDeadLiquidityFilter(300, 600), true);
  });

  it('applies bid-zone age and low-cap ranking adjustments', () => {
    assert.ok(
      tokenMarketBucket1m.__private.getMcapRankingBonus(250000)
      > tokenMarketBucket1m.__private.getMcapRankingBonus(6000000)
    );
    assert.equal(tokenMarketBucket1m.__private.getEarlyBidZoneBonus(24 * 10, 120000), 5);
    assert.equal(tokenMarketBucket1m.__private.getEarlyBidZoneBonus(24 * 20, 120000), 0);
    assert.equal(tokenMarketBucket1m.__private.getStaleLowCapPenalty(24 * 31, 140000), -10);
    assert.equal(tokenMarketBucket1m.__private.getActiveLiquidityBonus(1200, 25000), 6);
  });
});
