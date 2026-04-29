const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_OPTIONS,
  evaluatePumpfunPostMigrationBlastSignal,
} = require('../src/services/pumpfun-post-migration-blast-signal');

function buildSignal(overrides = {}) {
  return {
    source: 'pumpfun-migrated',
    migrationAgeMs: 6 * 60 * 1000,
    firstMcap: 12_355,
    currentMcap: 55_767,
    highMcapRecent: 75_588,
    maxVol5mRecent: 124_518,
    p95Vol5mRecent: 118_000,
    timeToHighMcapMs: 3 * 60 * 1000,
    bucketCoverage: 4,
    ...overrides,
  };
}

describe('PumpFun post-migration blast signal', () => {
  it('passes an immediate post-migration low-cap volume blast', () => {
    const result = evaluatePumpfunPostMigrationBlastSignal(buildSignal());

    assert.equal(result.passes, true);
    assert.equal(result.reason, 'passed');
    assert.equal(result.evidence.ruleKey, 'pumpfun-post-migration-blast');
    assert.equal(result.evidence.firstMcap, 12_355);
    assert.equal(result.evidence.highMcapRecent, 75_588);
    assert.equal(result.evidence.highMultiple, 6.12);
    assert.equal(result.score > 80, true);
  });

  it('rejects non PumpFun migrated tokens', () => {
    const result = evaluatePumpfunPostMigrationBlastSignal(buildSignal({ source: 'dexscreener-discovery' }));

    assert.equal(result.passes, false);
    assert.equal(result.reason, 'not_pumpfun_migrated');
  });

  it('rejects tokens that already started too high for the blast experiment', () => {
    const result = evaluatePumpfunPostMigrationBlastSignal(buildSignal({ firstMcap: 90_000 }));

    assert.equal(result.passes, false);
    assert.equal(result.reason, 'first_mcap_above_max');
  });

  it('rejects sparse data before the minimal confirmation window', () => {
    const result = evaluatePumpfunPostMigrationBlastSignal(buildSignal({ bucketCoverage: 2 }));

    assert.equal(result.passes, false);
    assert.equal(result.reason, 'insufficient_bucket_coverage');
  });

  it('rejects high market cap moves that take too long', () => {
    const result = evaluatePumpfunPostMigrationBlastSignal(buildSignal({
      timeToHighMcapMs: DEFAULT_OPTIONS.maxTimeToHighMcapMs + 1000,
    }));

    assert.equal(result.passes, false);
    assert.equal(result.reason, 'time_to_high_mcap_too_slow');
  });

  it('rejects weak volume even when market cap blasts', () => {
    const result = evaluatePumpfunPostMigrationBlastSignal(buildSignal({
      maxVol5mRecent: 55_000,
      p95Vol5mRecent: 50_000,
    }));

    assert.equal(result.passes, false);
    assert.equal(result.reason, 'weak_blast_volume');
  });

  it('normalizes safe option caps', () => {
    const result = evaluatePumpfunPostMigrationBlastSignal(buildSignal(), {
      maxMigrationAgeMs: 1,
      minFirstMcap: -1,
      maxFirstMcap: 0,
      minHighMcapRecent: 0,
      maxTimeToHighMcapMs: 0,
      minMaxVol5mRecent: -1,
      minBucketCoverage: 0,
    });

    assert.equal(result.evidence.thresholds.maxMigrationAgeMs, 1);
    assert.equal(result.evidence.thresholds.minFirstMcap, 0);
    assert.equal(result.evidence.thresholds.maxFirstMcap, DEFAULT_OPTIONS.maxFirstMcap);
    assert.equal(result.evidence.thresholds.minBucketCoverage, DEFAULT_OPTIONS.minBucketCoverage);
  });
});
