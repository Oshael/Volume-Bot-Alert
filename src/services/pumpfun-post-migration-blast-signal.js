const PUMPFUN_POST_MIGRATION_BLAST_RULE_KEY = 'pumpfun-post-migration-blast';

const DEFAULT_OPTIONS = Object.freeze({
  maxMigrationAgeMs: 20 * 60 * 1000,
  minFirstMcap: 1_000,
  maxFirstMcap: 35_000,
  minHighMcapRecent: 75_000,
  maxTimeToHighMcapMs: 10 * 60 * 1000,
  minMaxVol5mRecent: 100_000,
  minBucketCoverage: 3,
});

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function roundMetric(value, digits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const factor = 10 ** digits;
  return Math.round(num * factor) / factor;
}

function resolveOptions(options = {}) {
  return {
    maxMigrationAgeMs: Math.max(1, Number(options.maxMigrationAgeMs) || DEFAULT_OPTIONS.maxMigrationAgeMs),
    minFirstMcap: Math.max(0, Number(options.minFirstMcap) || DEFAULT_OPTIONS.minFirstMcap),
    maxFirstMcap: Math.max(1, Number(options.maxFirstMcap) || DEFAULT_OPTIONS.maxFirstMcap),
    minHighMcapRecent: Math.max(1, Number(options.minHighMcapRecent) || DEFAULT_OPTIONS.minHighMcapRecent),
    maxTimeToHighMcapMs: Math.max(1, Number(options.maxTimeToHighMcapMs) || DEFAULT_OPTIONS.maxTimeToHighMcapMs),
    minMaxVol5mRecent: Math.max(0, Number(options.minMaxVol5mRecent) || DEFAULT_OPTIONS.minMaxVol5mRecent),
    minBucketCoverage: Math.max(1, Number(options.minBucketCoverage) || DEFAULT_OPTIONS.minBucketCoverage),
  };
}

function normalizeInput(input = {}) {
  return {
    source: String(input.source || '').trim().toLowerCase(),
    migrationAgeMs: toFiniteNumber(input.migrationAgeMs ?? input.migration_age_ms),
    firstMcap: toFiniteNumber(input.firstMcap ?? input.first_mcap),
    currentMcap: toFiniteNumber(input.currentMcap ?? input.current_mcap),
    highMcapRecent: toFiniteNumber(input.highMcapRecent ?? input.high_mcap_recent),
    maxVol5mRecent: toFiniteNumber(input.maxVol5mRecent ?? input.max_vol_5m_recent),
    p95Vol5mRecent: toFiniteNumber(input.p95Vol5mRecent ?? input.p95_vol_5m_recent),
    timeToHighMcapMs: toFiniteNumber(input.timeToHighMcapMs ?? input.time_to_high_mcap_ms),
    bucketCoverage: toFiniteNumber(input.bucketCoverage ?? input.bucket_coverage ?? input.mcapBuckets ?? input.mcap_buckets),
  };
}

function buildEvidence(signal, options) {
  const highMultiple = signal.highMcapRecent != null && signal.firstMcap > 0
    ? signal.highMcapRecent / signal.firstMcap
    : null;
  const currentMultiple = signal.currentMcap != null && signal.firstMcap > 0
    ? signal.currentMcap / signal.firstMcap
    : null;

  return {
    ruleKey: PUMPFUN_POST_MIGRATION_BLAST_RULE_KEY,
    source: signal.source,
    migrationAgeMs: signal.migrationAgeMs,
    firstMcap: signal.firstMcap,
    currentMcap: signal.currentMcap,
    currentMultiple: roundMetric(currentMultiple),
    highMcapRecent: signal.highMcapRecent,
    highMultiple: roundMetric(highMultiple),
    maxVol5mRecent: signal.maxVol5mRecent,
    p95Vol5mRecent: signal.p95Vol5mRecent,
    strongestVol5m: Math.max(signal.maxVol5mRecent ?? 0, signal.p95Vol5mRecent ?? 0),
    timeToHighMcapMs: signal.timeToHighMcapMs,
    bucketCoverage: signal.bucketCoverage,
    thresholds: options,
  };
}

function scoreEvidence(evidence, options) {
  const mcapScore = Math.min((evidence.highMcapRecent || 0) / options.minHighMcapRecent, 2) * 30;
  const volScore = Math.min((evidence.strongestVol5m || 0) / Math.max(options.minMaxVol5mRecent, 1), 2) * 30;
  const speedRatio = evidence.timeToHighMcapMs == null
    ? 0
    : Math.max(0, 1 - (evidence.timeToHighMcapMs / options.maxTimeToHighMcapMs));
  const speedScore = speedRatio * 25;
  const coverageScore = Math.min((evidence.bucketCoverage || 0) / options.minBucketCoverage, 1) * 15;
  return roundMetric(mcapScore + volScore + speedScore + coverageScore);
}

function getFailureReason(signal, evidence, options) {
  if (signal.source !== 'pumpfun-migrated') return 'not_pumpfun_migrated';
  if (signal.migrationAgeMs == null || signal.migrationAgeMs < 0) return 'missing_migration_age';
  if (signal.migrationAgeMs > options.maxMigrationAgeMs) return 'migration_age_too_old';
  if (signal.firstMcap == null || signal.firstMcap <= 0) return 'missing_first_mcap';
  if (signal.firstMcap < options.minFirstMcap) return 'first_mcap_below_min';
  if (signal.firstMcap > options.maxFirstMcap) return 'first_mcap_above_max';
  if ((signal.bucketCoverage || 0) < options.minBucketCoverage) return 'insufficient_bucket_coverage';
  if ((signal.highMcapRecent || 0) < options.minHighMcapRecent) return 'high_mcap_not_reached';
  if (signal.timeToHighMcapMs == null || signal.timeToHighMcapMs < 0) return 'missing_time_to_high_mcap';
  if (signal.timeToHighMcapMs > options.maxTimeToHighMcapMs) return 'time_to_high_mcap_too_slow';
  if ((evidence.strongestVol5m || 0) < options.minMaxVol5mRecent) return 'weak_blast_volume';
  return null;
}

function evaluatePumpfunPostMigrationBlastSignal(input = {}, options = {}) {
  const resolvedOptions = resolveOptions(options);
  const signal = normalizeInput(input);
  const evidence = buildEvidence(signal, resolvedOptions);
  const failureReason = getFailureReason(signal, evidence, resolvedOptions);

  return {
    passes: failureReason == null,
    reason: failureReason || 'passed',
    score: scoreEvidence(evidence, resolvedOptions),
    evidence,
  };
}

module.exports = {
  PUMPFUN_POST_MIGRATION_BLAST_RULE_KEY,
  DEFAULT_OPTIONS,
  evaluatePumpfunPostMigrationBlastSignal,
  __private: {
    buildEvidence,
    normalizeInput,
    resolveOptions,
  },
};
