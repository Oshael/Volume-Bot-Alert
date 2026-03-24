const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const tokenMarketBucket1m = require('../src/models/token-market-bucket-1m');

describe('token market lateralization helpers', () => {
  it('uses wider range limits for lower-cap candidates', () => {
    assert.equal(tokenMarketBucket1m.__private.getRangeLimitPct(120000), 50);
    assert.equal(tokenMarketBucket1m.__private.getRangeLimitPct(2000000), 40);
    assert.equal(tokenMarketBucket1m.__private.getRangeLimitPct(8000000), 25);
  });

  it('gives a stronger ranking bonus to the 150k-500k mcap band', () => {
    assert.ok(
      tokenMarketBucket1m.__private.getMcapRankingBonus(250000)
      > tokenMarketBucket1m.__private.getMcapRankingBonus(6000000)
    );
  });

  it('gives large caps more room on drift limits', () => {
    assert.equal(tokenMarketBucket1m.__private.getDriftLimitPct(2000000), 14);
    assert.equal(tokenMarketBucket1m.__private.getDriftLimitPct(8000000), 10);
  });

  it('requires longer minimum windows for larger market caps', () => {
    assert.equal(tokenMarketBucket1m.__private.getMinimumWindowHoursForMcap(250000), 16);
    assert.equal(tokenMarketBucket1m.__private.getMinimumWindowHoursForMcap(1000000), 32);
    assert.equal(tokenMarketBucket1m.__private.getMinimumWindowHoursForMcap(7500000), 32);
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

  it('rejects candidates with low 1h volume even if 24h liquidity is healthy', () => {
    const scored = tokenMarketBucket1m.__private.scoreLateralizedCandidate({
      last_mcap: 240000,
      max_high_mcap: 250000,
      min_low_mcap: 220000,
      avg_close_mcap: 236000,
      first_mcap: 232000,
      last_mcap_window: 238000,
      close_mcap_stddev: 4000,
      last_vol_1h: 400,
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
});
