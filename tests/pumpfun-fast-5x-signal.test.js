const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  PUMPFUN_FAST_5X_RULE_KEY,
  evaluatePumpfunFast5xSignal,
} = require('../src/services/pumpfun-fast-5x-signal');

function createStrongSignal(overrides = {}) {
  return {
    source: 'pumpfun-migrated',
    migrationAgeMs: 12 * 60 * 1000,
    firstMcap: 24_000,
    currentMcap: 58_000,
    p95McapRecent: 62_000,
    p95Vol5mRecent: 85_000,
    avgVol5mFirst30m: 72_000,
    timeTo2xMs: 6 * 60 * 1000,
    bucketCoverage: 45,
    ...overrides,
  };
}

describe('PumpFun fast 5x signal', () => {
  it('passes a recent migrated low-cap token with fast 2x confirmation and strong early volume', () => {
    const result = evaluatePumpfunFast5xSignal(createStrongSignal());

    assert.equal(result.passes, true);
    assert.equal(result.reason, 'passed');
    assert.equal(result.evidence.ruleKey, PUMPFUN_FAST_5X_RULE_KEY);
    assert.equal(result.evidence.currentMultiple, 2.42);
    assert.equal(result.evidence.p95McapMultiple, 2.58);
    assert.ok(result.score > 80);
  });

  it('rejects non PumpFun migrated tokens to keep the first version scoped', () => {
    const result = evaluatePumpfunFast5xSignal(createStrongSignal({
      source: 'dexscreener-discovery',
    }));

    assert.equal(result.passes, false);
    assert.equal(result.reason, 'not_pumpfun_migrated');
  });

  it('rejects old migrated tokens even when market behavior is strong', () => {
    const result = evaluatePumpfunFast5xSignal(createStrongSignal({
      migrationAgeMs: 90 * 60 * 1000,
    }));

    assert.equal(result.passes, false);
    assert.equal(result.reason, 'migration_age_too_old');
  });

  it('rejects first market caps outside the experimental low-cap range', () => {
    assert.equal(
      evaluatePumpfunFast5xSignal(createStrongSignal({ firstMcap: 12_000 })).reason,
      'first_mcap_below_min'
    );
    assert.equal(
      evaluatePumpfunFast5xSignal(createStrongSignal({ firstMcap: 90_000 })).reason,
      'first_mcap_above_max'
    );
  });

  it('rejects high-volume tokens when market cap did not confirm a 2x move', () => {
    const result = evaluatePumpfunFast5xSignal(createStrongSignal({
      currentMcap: 39_000,
      p95McapRecent: 41_000,
    }));

    assert.equal(result.passes, false);
    assert.equal(result.reason, 'mcap_not_confirmed');
  });

  it('does not let rounded display multiples pass the 2x confirmation gate', () => {
    const result = evaluatePumpfunFast5xSignal(createStrongSignal({
      firstMcap: 20_000,
      currentMcap: 39_920,
      p95McapRecent: 39_920,
    }));

    assert.equal(result.evidence.currentMultiple, 2);
    assert.equal(result.passes, false);
    assert.equal(result.reason, 'mcap_not_confirmed');
  });

  it('rejects slow 2x moves because this rule targets fast continuation', () => {
    const result = evaluatePumpfunFast5xSignal(createStrongSignal({
      timeTo2xMs: 26 * 60 * 1000,
    }));

    assert.equal(result.passes, false);
    assert.equal(result.reason, 'time_to_2x_too_slow');
  });

  it('rejects weak early volume even when the token already doubled', () => {
    const result = evaluatePumpfunFast5xSignal(createStrongSignal({
      p95Vol5mRecent: 22_000,
      avgVol5mFirst30m: 19_000,
    }));

    assert.equal(result.passes, false);
    assert.equal(result.reason, 'weak_early_volume');
  });

  it('allows either p95 volume or first-30m average volume to satisfy the volume gate', () => {
    const highP95 = evaluatePumpfunFast5xSignal(createStrongSignal({
      p95Vol5mRecent: 45_000,
      avgVol5mFirst30m: 10_000,
    }));
    const highAverage = evaluatePumpfunFast5xSignal(createStrongSignal({
      p95Vol5mRecent: 10_000,
      avgVol5mFirst30m: 45_000,
    }));

    assert.equal(highP95.passes, true);
    assert.equal(highAverage.passes, true);
  });

  it('rejects sparse buckets so dry-run data cannot learn from thin coverage', () => {
    const result = evaluatePumpfunFast5xSignal(createStrongSignal({
      bucketCoverage: 8,
    }));

    assert.equal(result.passes, false);
    assert.equal(result.reason, 'insufficient_bucket_coverage');
  });
});
