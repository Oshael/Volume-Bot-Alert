const PUMPFUN_FAST_5X_RULE_KEY = 'pumpfun-fast-5x';

const DEFAULT_OPTIONS = Object.freeze({
  maxMigrationAgeMs: 60 * 60 * 1000,
  minFirstMcap: 15_000,
  maxFirstMcap: 80_000,
  minAlertMcap: 50_000,
  maxAlertMcap: 200_000,
  maxTimeTo2xMs: 15 * 60 * 1000,
  minP95Vol5m: 40_000,
  minAvgVol5mFirst30m: 40_000,
  minMcapMultiple: 2,
  minBucketCoverage: 12,
});

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function roundMetric(value, digits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  const factor = 10 ** digits;
  return Math.round(num * factor) / factor;
}

function resolveOptions(options = {}) {
  return {
    maxMigrationAgeMs: Math.max(1, Number(options.maxMigrationAgeMs) || DEFAULT_OPTIONS.maxMigrationAgeMs),
    minFirstMcap: Math.max(0, Number(options.minFirstMcap) || DEFAULT_OPTIONS.minFirstMcap),
    maxFirstMcap: Math.max(1, Number(options.maxFirstMcap) || DEFAULT_OPTIONS.maxFirstMcap),
    minAlertMcap: Math.max(0, Number(options.minAlertMcap) || DEFAULT_OPTIONS.minAlertMcap),
    maxAlertMcap: Math.max(1, Number(options.maxAlertMcap) || DEFAULT_OPTIONS.maxAlertMcap),
    maxTimeTo2xMs: Math.max(1, Number(options.maxTimeTo2xMs) || DEFAULT_OPTIONS.maxTimeTo2xMs),
    minP95Vol5m: Math.max(0, Number(options.minP95Vol5m) || DEFAULT_OPTIONS.minP95Vol5m),
    minAvgVol5mFirst30m: Math.max(0, Number(options.minAvgVol5mFirst30m) || DEFAULT_OPTIONS.minAvgVol5mFirst30m),
    minMcapMultiple: Math.max(1, Number(options.minMcapMultiple) || DEFAULT_OPTIONS.minMcapMultiple),
    minBucketCoverage: Math.max(1, Number(options.minBucketCoverage) || DEFAULT_OPTIONS.minBucketCoverage),
  };
}

function normalizeInput(input = {}) {
  const firstMcap = toFiniteNumber(input.firstMcap ?? input.first_mcap);
  const currentMcap = toFiniteNumber(input.currentMcap ?? input.current_mcap);
  const p95McapRecent = toFiniteNumber(input.p95McapRecent ?? input.p95_mcap_recent ?? input.p95Mcap ?? input.p95_mcap);
  const p95Vol5mRecent = toFiniteNumber(input.p95Vol5mRecent ?? input.p95_vol_5m_recent ?? input.p95Vol5m ?? input.p95_vol_5m);
  const avgVol5mFirst30m = toFiniteNumber(input.avgVol5mFirst30m ?? input.avg_vol_5m_first_30m);
  const timeTo2xMs = toFiniteNumber(input.timeTo2xMs ?? input.time_to_2x_ms);
  const bucketCoverage = toFiniteNumber(input.bucketCoverage ?? input.bucket_coverage ?? input.mcapBuckets ?? input.mcap_buckets);

  return {
    source: String(input.source || '').trim().toLowerCase(),
    migrationAgeMs: toFiniteNumber(input.migrationAgeMs ?? input.migration_age_ms),
    firstMcap,
    currentMcap,
    p95McapRecent,
    p95Vol5mRecent,
    avgVol5mFirst30m,
    timeTo2xMs,
    bucketCoverage,
  };
}

function buildEvidence(signal, options) {
  const currentMultiple = signal.currentMcap != null && signal.firstMcap > 0
    ? signal.currentMcap / signal.firstMcap
    : null;
  const p95McapMultiple = signal.p95McapRecent != null && signal.firstMcap > 0
    ? signal.p95McapRecent / signal.firstMcap
    : null;
  const strongestMcapMultiple = Math.max(
    currentMultiple ?? 0,
    p95McapMultiple ?? 0
  );
  const strongestVol5m = Math.max(
    signal.p95Vol5mRecent ?? 0,
    signal.avgVol5mFirst30m ?? 0
  );
  const alertMcap = signal.currentMcap ?? signal.p95McapRecent ?? null;

  return {
    ruleKey: PUMPFUN_FAST_5X_RULE_KEY,
    source: signal.source,
    migrationAgeMs: signal.migrationAgeMs,
    firstMcap: signal.firstMcap,
    alertMcap,
    currentMcap: signal.currentMcap,
    currentMultiple: roundMetric(currentMultiple),
    p95McapRecent: signal.p95McapRecent,
    p95McapMultiple: roundMetric(p95McapMultiple),
    strongestMcapMultiple,
    p95Vol5mRecent: signal.p95Vol5mRecent,
    avgVol5mFirst30m: signal.avgVol5mFirst30m,
    strongestVol5m,
    timeTo2xMs: signal.timeTo2xMs,
    bucketCoverage: signal.bucketCoverage,
    thresholds: options,
  };
}

function scoreEvidence(evidence, options) {
  const mcapScore = Math.min(evidence.strongestMcapMultiple / options.minMcapMultiple, 2) * 30;
  const volScore = Math.min(evidence.strongestVol5m / Math.max(options.minP95Vol5m, options.minAvgVol5mFirst30m, 1), 2) * 25;
  const speedRatio = evidence.timeTo2xMs == null
    ? 0
    : Math.max(0, 1 - (evidence.timeTo2xMs / options.maxTimeTo2xMs));
  const speedScore = speedRatio * 25;
  const coverageScore = Math.min((evidence.bucketCoverage || 0) / options.minBucketCoverage, 1) * 20;
  return roundMetric(mcapScore + volScore + speedScore + coverageScore);
}

function getSourceFailure(signal) {
  if (signal.source !== 'pumpfun-migrated') return 'not_pumpfun_migrated';
  return null;
}

function getMigrationAgeFailure(signal, options) {
  if (signal.migrationAgeMs == null || signal.migrationAgeMs < 0) return 'missing_migration_age';
  if (signal.migrationAgeMs > options.maxMigrationAgeMs) return 'migration_age_too_old';
  return null;
}

function getFirstMcapFailure(signal, options) {
  if (signal.firstMcap == null || signal.firstMcap <= 0) return 'missing_first_mcap';
  if (signal.firstMcap < options.minFirstMcap) return 'first_mcap_below_min';
  if (signal.firstMcap > options.maxFirstMcap) return 'first_mcap_above_max';
  return null;
}

function getAlertMcapFailure(evidence, options) {
  if (evidence.alertMcap == null || evidence.alertMcap <= 0) return 'missing_alert_mcap';
  if (evidence.alertMcap < options.minAlertMcap) return 'alert_mcap_below_min';
  if (evidence.alertMcap > options.maxAlertMcap) return 'alert_mcap_above_max';
  return null;
}

function getCoverageFailure(signal, options) {
  if ((signal.bucketCoverage || 0) < options.minBucketCoverage) return 'insufficient_bucket_coverage';
  return null;
}

function getSpeedFailure(signal, options) {
  if (signal.timeTo2xMs == null || signal.timeTo2xMs < 0) return 'missing_time_to_2x';
  if (signal.timeTo2xMs > options.maxTimeTo2xMs) return 'time_to_2x_too_slow';
  return null;
}

function getConfirmationFailure(signal, evidence, options) {
  if (evidence.strongestMcapMultiple < options.minMcapMultiple) return 'mcap_not_confirmed';
  if (
    (signal.p95Vol5mRecent || 0) < options.minP95Vol5m
    && (signal.avgVol5mFirst30m || 0) < options.minAvgVol5mFirst30m
  ) {
    return 'weak_early_volume';
  }
  return null;
}

function getFailureReason(signal, evidence, options) {
  const validators = [
    () => getSourceFailure(signal),
    () => getMigrationAgeFailure(signal, options),
    () => getFirstMcapFailure(signal, options),
    () => getAlertMcapFailure(evidence, options),
    () => getCoverageFailure(signal, options),
    () => getSpeedFailure(signal, options),
    () => getConfirmationFailure(signal, evidence, options),
  ];

  for (const validate of validators) {
    const reason = validate();
    if (reason) return reason;
  }
  return null;
}

function evaluatePumpfunFast5xSignal(input = {}, options = {}) {
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
  PUMPFUN_FAST_5X_RULE_KEY,
  DEFAULT_OPTIONS,
  evaluatePumpfunFast5xSignal,
};
