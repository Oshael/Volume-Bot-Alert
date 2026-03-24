const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const tokenMarketBucket1m = require('../src/models/token-market-bucket-1m');

describe('token market lateralization helpers', () => {
  it('uses wider range limits for lower-cap candidates', () => {
    assert.equal(tokenMarketBucket1m.__private.getRangeLimitPct(120000), 60);
    assert.equal(tokenMarketBucket1m.__private.getRangeLimitPct(2000000), 35);
    assert.equal(tokenMarketBucket1m.__private.getRangeLimitPct(8000000), 20);
  });

  it('gives a stronger ranking bonus to the 150k-500k mcap band', () => {
    assert.ok(
      tokenMarketBucket1m.__private.getMcapRankingBonus(250000)
      > tokenMarketBucket1m.__private.getMcapRankingBonus(6000000)
    );
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
      last_vol_24h: 95000,
      bucket_count: 330,
      sample_count: 1100,
      last_token_created_at_ms: Date.now() - (10 * 60 * 60 * 1000),
    }, {
      hours: 6,
      minCoverageRatio: 0.7,
      minBuckets: 20,
      minVol24h: 10000,
      nowMs: Date.now(),
    });

    assert.equal(scored.passes, true);
    assert.ok((scored.score || 0) > 50);
  });
});
