const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const tokenMarketBucket1m = require('../src/models/token-market-bucket-1m');

describe('token market lateralization helpers', () => {
  it('uses wider range limits for lower-cap candidates', () => {
    assert.equal(tokenMarketBucket1m.__private.getRangeLimitPct(120000), 50);
    assert.equal(tokenMarketBucket1m.__private.getRangeLimitPct(2000000), 50);
    assert.equal(tokenMarketBucket1m.__private.getRangeLimitPct(4500000), 25);
    assert.equal(tokenMarketBucket1m.__private.getRangeLimitPct(8000000), 25);
  });

  it('gives a stronger ranking bonus to the 150k-500k mcap band', () => {
    assert.ok(
      tokenMarketBucket1m.__private.getMcapRankingBonus(250000)
      > tokenMarketBucket1m.__private.getMcapRankingBonus(6000000)
    );
  });

  it('gives large caps more room on drift limits', () => {
    assert.equal(tokenMarketBucket1m.__private.getDriftLimitPct(2000000), 16);
    assert.equal(tokenMarketBucket1m.__private.getDriftLimitPct(4500000), 14);
    assert.equal(tokenMarketBucket1m.__private.getDriftLimitPct(8000000), 14);
  });

  it('requires longer minimum windows for larger market caps', () => {
    assert.equal(tokenMarketBucket1m.__private.getMinimumWindowHoursForMcap(250000), 16);
    assert.equal(tokenMarketBucket1m.__private.getMinimumWindowHoursForMcap(1000000), 32);
    assert.equal(tokenMarketBucket1m.__private.getMinimumWindowHoursForMcap(7500000), 32);
  });

  it('switches the candidate-pool band at 4m market cap', () => {
    assert.equal(tokenMarketBucket1m.__private.getCandidatePoolBand(2500000), 'm1_to_4m');
    assert.equal(tokenMarketBucket1m.__private.getCandidatePoolBand(4500000), 'm4_plus');
  });

  it('scores a compressed, covered candidate as a passing lateralization candidate', () => {
    const scored = tokenMarketBucket1m.__private.scoreLateralizedCandidate({
      last_mcap: 240000,
      max_high_mcap: 250000,
      min_low_mcap: 220000,
      avg_close_mcap: 236000,
      first_mcap: 232000,
      last_mcap_window: 238000,
      close_mcap_stddev: 4000,
      last_vol_1h: 12000,
      last_vol_24h: 95000,
      bucket_count: 330,
      sample_count: 1100,
      last_token_created_at_ms: Date.now() - (10 * 60 * 60 * 1000),
    }, {
      hours: 6,
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

  it('penalizes low 1h volume instead of rejecting the candidate outright', () => {
    const scored = tokenMarketBucket1m.__private.scoreLateralizedCandidate({
      last_mcap: 240000,
      max_high_mcap: 250000,
      min_low_mcap: 220000,
      avg_close_mcap: 236000,
      first_mcap: 232000,
      last_mcap_window: 238000,
      close_mcap_stddev: 4000,
      last_vol_1h: 400,
      last_vol_6h: 4000,
      last_vol_24h: 95000,
      bucket_count: 330,
      sample_count: 1100,
      last_token_created_at_ms: Date.now() - (48 * 60 * 60 * 1000),
    }, {
      hours: 6,
      minMcap: 90000,
      minVol1h: 1000,
      minCoverageRatio: 0.7,
      minBuckets: 20,
      minVol24h: 10000,
      nowMs: Date.now(),
    });

    assert.equal(scored.passes, true);
    assert.equal(scored.liquidityPenalty, -1);
  });

  it('rejects candidates sitting too close to the edge of the range', () => {
    const scored = tokenMarketBucket1m.__private.scoreLateralizedCandidate({
      last_mcap: 240000,
      max_high_mcap: 250000,
      min_low_mcap: 220000,
      avg_close_mcap: 236000,
      first_mcap: 232000,
      last_mcap_window: 221000,
      close_mcap_stddev: 4000,
      last_vol_1h: 12000,
      last_vol_6h: 24000,
      last_vol_24h: 95000,
      bucket_count: 330,
      sample_count: 1100,
      last_token_created_at_ms: Date.now() - (48 * 60 * 60 * 1000),
    }, {
      hours: 6,
      minMcap: 90000,
      minVol1h: 1000,
      minCoverageRatio: 0.7,
      minBuckets: 20,
      minVol24h: 10000,
      nowMs: Date.now(),
    });

    assert.equal(scored.passes, false);
    assert.equal(scored.passesPosition, false);
  });

  it('prefers fresh-but-not-brand-new candidates over older ones', () => {
    const fresh = tokenMarketBucket1m.__private.getAgeRankingBonus(72);
    const old = tokenMarketBucket1m.__private.getAgeRankingBonus(24 * 40);

    assert.ok(fresh > old);
  });

  it('computes sample stddev for close-mcap series', () => {
    const value = tokenMarketBucket1m.__private.computeSampleStddev([10, 12, 14]);

    assert.ok(value != null);
    assert.ok(value > 1.9 && value < 2.1);
  });

  it('adds a quality bonus for compressed and liquid high caps', () => {
    const strong = tokenMarketBucket1m.__private.getHighCapQualityBonus(2500000, 18, 5, 8000, 120000);
    const weak = tokenMarketBucket1m.__private.getHighCapQualityBonus(2500000, 32, 12, 1200, 20000);

    assert.ok(strong > weak);
  });

  it('applies stronger 1h-volume penalties to very thin candidates', () => {
    assert.equal(tokenMarketBucket1m.__private.getLiquidityRankingAdjustment(100, 200), -12);
    assert.equal(tokenMarketBucket1m.__private.getLiquidityRankingAdjustment(150, 6000), -12);
    assert.equal(tokenMarketBucket1m.__private.getLiquidityRankingAdjustment(400, 400), -4);
    assert.equal(tokenMarketBucket1m.__private.getLiquidityRankingAdjustment(400, 4000), -1);
    assert.equal(tokenMarketBucket1m.__private.getLiquidityRankingAdjustment(1200, 1200), 0);
  });

  it('rejects only the really dead recent-liquidity profile', () => {
    assert.equal(tokenMarketBucket1m.__private.passesDeadLiquidityFilter(90, 1400), false);
    assert.equal(tokenMarketBucket1m.__private.passesDeadLiquidityFilter(90, 2000), true);
    assert.equal(tokenMarketBucket1m.__private.passesDeadLiquidityFilter(300, 600), true);
  });

  it('penalizes stale sub-150k tokens after one month', () => {
    assert.equal(tokenMarketBucket1m.__private.getStaleLowCapPenalty(24 * 31, 140000), -10);
    assert.equal(tokenMarketBucket1m.__private.getStaleLowCapPenalty(24 * 31, 180000), 0);
  });

  it('rewards active coins with strong 1h and 6h volume', () => {
    assert.equal(tokenMarketBucket1m.__private.getActiveLiquidityBonus(1200, 25000), 6);
    assert.equal(tokenMarketBucket1m.__private.getActiveLiquidityBonus(900, 25000), 0);
  });

  it('adds a modest bid-zone bonus for newer 90k-180k candidates', () => {
    assert.equal(tokenMarketBucket1m.__private.getEarlyBidZoneBonus(24 * 10, 120000), 5);
    assert.equal(tokenMarketBucket1m.__private.getEarlyBidZoneBonus(24 * 20, 120000), 0);
    assert.equal(tokenMarketBucket1m.__private.getEarlyBidZoneBonus(24 * 10, 220000), 0);
  });
});
