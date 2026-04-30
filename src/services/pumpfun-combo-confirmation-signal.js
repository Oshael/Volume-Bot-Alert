const PUMPFUN_COMBO_CONFIRMATION_RULE_KEY = 'pumpfun-combo-confirmation';

const DEFAULT_OPTIONS = Object.freeze({
  minBlastAlertMcap: 50_000,
  maxBlastAlertMcap: 100_000,
  minBlastScore: 120,
  maxBlastTimeToHighMcapMs: 6 * 60 * 1000,
  maxFastConfirmationDelayMs: 60 * 60 * 1000,
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
    minBlastAlertMcap: Math.max(1, Number(options.minBlastAlertMcap) || DEFAULT_OPTIONS.minBlastAlertMcap),
    maxBlastAlertMcap: Math.max(1, Number(options.maxBlastAlertMcap) || DEFAULT_OPTIONS.maxBlastAlertMcap),
    minBlastScore: Math.max(0, Number(options.minBlastScore) || DEFAULT_OPTIONS.minBlastScore),
    maxBlastTimeToHighMcapMs: Math.max(1, Number(options.maxBlastTimeToHighMcapMs) || DEFAULT_OPTIONS.maxBlastTimeToHighMcapMs),
    maxFastConfirmationDelayMs: Math.max(1, Number(options.maxFastConfirmationDelayMs) || DEFAULT_OPTIONS.maxFastConfirmationDelayMs),
  };
}

function normalizeInput(input = {}) {
  return {
    blastAlertMcap: toFiniteNumber(input.blastAlertMcap ?? input.blast_alert_mcap),
    blastScore: toFiniteNumber(input.blastScore ?? input.blast_score),
    blastTimeToHighMcapMs: toFiniteNumber(input.blastTimeToHighMcapMs ?? input.blast_time_to_high_mcap_ms),
    blastHighMcapRecent: toFiniteNumber(input.blastHighMcapRecent ?? input.blast_high_mcap_recent),
    blastStrongestVol5m: toFiniteNumber(input.blastStrongestVol5m ?? input.blast_strongest_vol_5m),
    hasFastConfirmation: Boolean(input.hasFastConfirmation ?? input.has_fast_confirmation),
    fastConfirmationDelayMs: toFiniteNumber(input.fastConfirmationDelayMs ?? input.fast_confirmation_delay_ms),
    fastAlertMcap: toFiniteNumber(input.fastAlertMcap ?? input.fast_alert_mcap),
    fastScore: toFiniteNumber(input.fastScore ?? input.fast_score),
    fastTimeTo2xMs: toFiniteNumber(input.fastTimeTo2xMs ?? input.fast_time_to_2x_ms),
    preBuckets: toFiniteNumber(input.preBuckets ?? input.pre_buckets),
    preHighMcap: toFiniteNumber(input.preHighMcap ?? input.pre_high_mcap),
    maxPreVol5m: toFiniteNumber(input.maxPreVol5m ?? input.max_pre_vol_5m),
  };
}

function buildEvidence(signal, options) {
  const fastDelayMinutes = signal.fastConfirmationDelayMs == null
    ? null
    : signal.fastConfirmationDelayMs / 60000;
  const blastHighMultiple = signal.blastHighMcapRecent != null && signal.blastAlertMcap > 0
    ? signal.blastHighMcapRecent / signal.blastAlertMcap
    : null;

  return {
    ruleKey: PUMPFUN_COMBO_CONFIRMATION_RULE_KEY,
    blastAlertMcap: signal.blastAlertMcap,
    blastScore: signal.blastScore,
    blastTimeToHighMcapMs: signal.blastTimeToHighMcapMs,
    blastHighMcapRecent: signal.blastHighMcapRecent,
    blastHighMultiple: roundMetric(blastHighMultiple),
    blastStrongestVol5m: signal.blastStrongestVol5m,
    hasFastConfirmation: signal.hasFastConfirmation,
    fastConfirmationDelayMs: signal.fastConfirmationDelayMs,
    fastConfirmationDelayMinutes: roundMetric(fastDelayMinutes),
    fastAlertMcap: signal.fastAlertMcap,
    fastScore: signal.fastScore,
    fastTimeTo2xMs: signal.fastTimeTo2xMs,
    preBuckets: signal.preBuckets,
    preHighMcap: signal.preHighMcap,
    maxPreVol5m: signal.maxPreVol5m,
    thresholds: options,
  };
}

function scoreEvidence(evidence, options) {
  const mcapMidpoint = (options.minBlastAlertMcap + options.maxBlastAlertMcap) / 2;
  const mcapDistance = Math.abs((evidence.blastAlertMcap || 0) - mcapMidpoint) / mcapMidpoint;
  const mcapScore = Math.max(0, 1 - mcapDistance) * 25;
  const blastScore = Math.min((evidence.blastScore || 0) / Math.max(options.minBlastScore, 1), 1.5) * 25;
  const speedRatio = evidence.blastTimeToHighMcapMs == null
    ? 0
    : Math.max(0, 1 - (evidence.blastTimeToHighMcapMs / options.maxBlastTimeToHighMcapMs));
  const speedScore = speedRatio * 25;
  const fastScore = evidence.hasFastConfirmation ? 15 : 0;
  const preScore = Math.min((evidence.preHighMcap || 0) / 35_000, 1) * 10;
  return roundMetric(mcapScore + blastScore + speedScore + fastScore + preScore);
}

function getFailureReason(signal, options) {
  if (signal.blastAlertMcap == null || signal.blastAlertMcap <= 0) return 'missing_blast_alert_mcap';
  if (signal.blastAlertMcap < options.minBlastAlertMcap) return 'blast_alert_mcap_below_combo_band';
  if (signal.blastAlertMcap > options.maxBlastAlertMcap) return 'blast_alert_mcap_above_combo_band';
  if ((signal.blastScore || 0) < options.minBlastScore) return 'blast_score_below_combo_min';
  if (signal.blastTimeToHighMcapMs == null || signal.blastTimeToHighMcapMs < 0) {
    return 'missing_blast_time_to_high_mcap';
  }
  if (signal.blastTimeToHighMcapMs > options.maxBlastTimeToHighMcapMs) {
    return 'blast_time_to_high_mcap_too_slow';
  }
  if (
    signal.hasFastConfirmation
    && signal.fastConfirmationDelayMs != null
    && signal.fastConfirmationDelayMs < 0
  ) {
    return 'fast_confirmation_before_blast';
  }
  if (
    signal.hasFastConfirmation
    && signal.fastConfirmationDelayMs != null
    && signal.fastConfirmationDelayMs > options.maxFastConfirmationDelayMs
  ) {
    return 'fast_confirmation_too_late';
  }
  return null;
}

function evaluatePumpfunComboConfirmationSignal(input = {}, options = {}) {
  const resolvedOptions = resolveOptions(options);
  const signal = normalizeInput(input);
  const evidence = buildEvidence(signal, resolvedOptions);
  const failureReason = getFailureReason(signal, resolvedOptions);

  return {
    passes: failureReason == null,
    reason: failureReason || (signal.hasFastConfirmation ? 'blast_with_fast_confirmation' : 'blast_core'),
    score: scoreEvidence(evidence, resolvedOptions),
    evidence,
  };
}

module.exports = {
  PUMPFUN_COMBO_CONFIRMATION_RULE_KEY,
  DEFAULT_OPTIONS,
  evaluatePumpfunComboConfirmationSignal,
  __private: {
    buildEvidence,
    normalizeInput,
    resolveOptions,
  },
};
