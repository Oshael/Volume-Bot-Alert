const MONITORED_VOL_COLD_RESET_MAX_VOLUME_5M = 5_000;
const MONITORED_VOL_COLD_RESET_DURATION_MS = 30 * 60 * 1000;
const MONITORED_VOL_COLD_HOT_BLIP_GRACE_MS = 60 * 1000;
const MONITORED_VOL_COLD_SINCE_METADATA_KEY = 'monitoredVolColdSinceAt';
const MONITORED_VOL_HOT_SINCE_METADATA_KEY = 'monitoredVolHotSinceAt';
const SURGE_6H_RESET_MAX_PCHANGE_PCT = 25;
const SURGE_6H_RESET_PCHANGE_DURATION_MS = 2 * 60 * 60 * 1000;
const SURGE_6H_RESET_DRAWDOWN_RATIO = 0.60;
const SURGE_6H_RESET_DRAWDOWN_DURATION_MS = 60 * 60 * 1000;
const SURGE_1H_RESET_PCHANGE_THRESHOLD_RATIO = 0.40;
const SURGE_1H_RESET_PCHANGE_DURATION_MS = 30 * 60 * 1000;
const SURGE_1H_RESET_DRAWDOWN_RATIO = 0.60;
const SURGE_1H_RESET_DRAWDOWN_DURATION_MS = 30 * 60 * 1000;
const SURGE_RESET_PCHANGE_SINCE_METADATA_KEY = 'surgeResetPchangeSinceAt';
const SURGE_RESET_DRAWDOWN_SINCE_METADATA_KEY = 'surgeResetDrawdownSinceAt';

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampMs(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
}

function isSixHourSurgeRule(ruleKey) {
  return ruleKey === 'recent-surge-6h' || ruleKey === 'old-week-surge-6h';
}

function isOneHourSurgeRule(ruleKey) {
  return ruleKey === 'recent-surge-1h' || ruleKey === 'old-week-surge-1h';
}

function getSurgeResetConfig(ruleKey, thresholdPct) {
  if (isSixHourSurgeRule(ruleKey)) {
    return {
      maxPchangePct: SURGE_6H_RESET_MAX_PCHANGE_PCT,
      pchangeDurationMs: SURGE_6H_RESET_PCHANGE_DURATION_MS,
      drawdownRatio: SURGE_6H_RESET_DRAWDOWN_RATIO,
      drawdownDurationMs: SURGE_6H_RESET_DRAWDOWN_DURATION_MS,
      window: '6H',
    };
  }
  if (!isOneHourSurgeRule(ruleKey)) return null;
  const threshold = numberOrNull(thresholdPct);
  return {
    maxPchangePct: threshold == null ? null : threshold * SURGE_1H_RESET_PCHANGE_THRESHOLD_RATIO,
    pchangeDurationMs: SURGE_1H_RESET_PCHANGE_DURATION_MS,
    drawdownRatio: SURGE_1H_RESET_DRAWDOWN_RATIO,
    drawdownDurationMs: SURGE_1H_RESET_DRAWDOWN_DURATION_MS,
    window: '1H',
  };
}

function metadataTimestamp(state, key) {
  return timestampMs(state?.metadata?.[key]);
}

function isMonitoredVolAnchorExpired(candidate, state, nowMs) {
  if (candidate?.ruleKey !== 'monitored-vol' || state?.status !== 'rearmed') return false;
  const coldSinceMs = metadataTimestamp(state, MONITORED_VOL_COLD_SINCE_METADATA_KEY);
  return coldSinceMs != null && (nowMs - coldSinceMs) >= MONITORED_VOL_COLD_RESET_DURATION_MS;
}

function isSurgeAnchorExpired(candidate, state, nowMs, options = {}) {
  const config = getSurgeResetConfig(candidate?.ruleKey, null);
  if (!config || state?.status !== 'rearmed') return false;
  if (isSixHourSurgeRule(candidate?.ruleKey) && options.cooldownActive === true) return false;
  const pchangeSinceMs = metadataTimestamp(state, SURGE_RESET_PCHANGE_SINCE_METADATA_KEY);
  if (pchangeSinceMs != null && (nowMs - pchangeSinceMs) >= config.pchangeDurationMs) return true;
  const drawdownSinceMs = metadataTimestamp(state, SURGE_RESET_DRAWDOWN_SINCE_METADATA_KEY);
  return drawdownSinceMs != null && (nowMs - drawdownSinceMs) >= config.drawdownDurationMs;
}

function updateSurgePchangeMetadata(metadata, state, observation, nowMs, config) {
  const current = numberOrNull(config.window === '6H'
    ? observation?.priceChange6h : observation?.priceChange1h);
  if (current == null || config.maxPchangePct == null) return false;
  const sinceMs = metadataTimestamp(state, SURGE_RESET_PCHANGE_SINCE_METADATA_KEY);
  if (current <= config.maxPchangePct) {
    if (sinceMs != null) return false;
    metadata[SURGE_RESET_PCHANGE_SINCE_METADATA_KEY] = new Date(nowMs).toISOString();
    metadata.surgeResetPchangeMaxPct = config.maxPchangePct;
    return true;
  }
  if (sinceMs == null) return false;
  delete metadata[SURGE_RESET_PCHANGE_SINCE_METADATA_KEY];
  delete metadata.surgeResetPchangeMaxPct;
  metadata.surgeResetPchangeInterruptedAt = new Date(nowMs).toISOString();
  metadata.surgeResetPchangeInterruptedPct = current;
  return true;
}

function updateSurgeDrawdownMetadata(metadata, state, valuation, nowMs, config, keys) {
  const current = numberOrNull(valuation);
  if (!(current > 0)) return false;
  const previousHigh = numberOrNull(metadata[keys.high])
    ?? numberOrNull(state?.metadata?.[keys.lastAlerted]) ?? current;
  const nextHigh = Math.max(previousHigh, current);
  const highChanged = nextHigh !== previousHigh;
  metadata[keys.high] = nextHigh;
  const sinceMs = metadataTimestamp(state, SURGE_RESET_DRAWDOWN_SINCE_METADATA_KEY);
  if (current <= nextHigh * config.drawdownRatio) {
    if (sinceMs != null) return highChanged;
    metadata[SURGE_RESET_DRAWDOWN_SINCE_METADATA_KEY] = new Date(nowMs).toISOString();
    metadata.surgeResetDrawdownRatio = config.drawdownRatio;
    return true;
  }
  if (sinceMs == null) return highChanged;
  delete metadata[SURGE_RESET_DRAWDOWN_SINCE_METADATA_KEY];
  delete metadata.surgeResetDrawdownRatio;
  metadata.surgeResetDrawdownInterruptedAt = new Date(nowMs).toISOString();
  metadata[keys.interrupted] = current;
  return true;
}

function buildSurgeResetMetadata(input = {}) {
  const metadata = { ...(input.state?.metadata || {}) };
  const config = getSurgeResetConfig(input.ruleKey, input.thresholdPct);
  if (!config) return { metadata, changed: false };
  const pchangeChanged = updateSurgePchangeMetadata(
    metadata, input.state, input.observation, input.nowMs, config,
  );
  const drawdownChanged = updateSurgeDrawdownMetadata(
    metadata, input.state, input.observation?.valuation, input.nowMs, config, input.valuationKeys,
  );
  return { metadata, changed: pchangeChanged || drawdownChanged };
}

function buildSurgePostAlertHighMetadata(input = {}) {
  const metadata = { ...(input.state?.metadata || {}) };
  const current = numberOrNull(input.valuation);
  if ((!isOneHourSurgeRule(input.ruleKey) && !isSixHourSurgeRule(input.ruleKey)) || !(current > 0)) {
    return { metadata, changed: false };
  }
  const previousHigh = numberOrNull(metadata[input.valuationKeys.high])
    ?? numberOrNull(input.state?.metadata?.[input.valuationKeys.lastAlerted]) ?? current;
  if (current <= previousHigh) return { metadata, changed: false };
  metadata[input.valuationKeys.high] = current;
  return { metadata, changed: true };
}

function buildMonitoredVolColdMetadata(state, volume5m, nowMs) {
  const metadata = { ...(state?.metadata || {}) };
  const current = numberOrNull(volume5m);
  const coldSinceMs = metadataTimestamp(state, MONITORED_VOL_COLD_SINCE_METADATA_KEY);
  const hotSinceMs = timestampMs(metadata[MONITORED_VOL_HOT_SINCE_METADATA_KEY]);
  if (current == null) return { metadata, changed: false };
  if (current <= MONITORED_VOL_COLD_RESET_MAX_VOLUME_5M) {
    if (coldSinceMs != null) {
      if (hotSinceMs == null) return { metadata, changed: false };
      delete metadata[MONITORED_VOL_HOT_SINCE_METADATA_KEY];
      delete metadata.monitoredVolHotVolume5m;
      return { metadata, changed: true };
    }
    metadata[MONITORED_VOL_COLD_SINCE_METADATA_KEY] = new Date(nowMs).toISOString();
    metadata.monitoredVolColdMaxVolume5m = MONITORED_VOL_COLD_RESET_MAX_VOLUME_5M;
    delete metadata[MONITORED_VOL_HOT_SINCE_METADATA_KEY];
    delete metadata.monitoredVolHotVolume5m;
    delete metadata.monitoredVolColdInterruptedAt;
    delete metadata.monitoredVolColdInterruptedVolume5m;
    return { metadata, changed: true };
  }
  if (coldSinceMs == null) return { metadata, changed: false };
  if (hotSinceMs == null) {
    metadata[MONITORED_VOL_HOT_SINCE_METADATA_KEY] = new Date(nowMs).toISOString();
    metadata.monitoredVolHotVolume5m = current;
    return { metadata, changed: true };
  }
  if ((nowMs - hotSinceMs) <= MONITORED_VOL_COLD_HOT_BLIP_GRACE_MS) {
    metadata.monitoredVolHotVolume5m = current;
    return { metadata, changed: true };
  }
  delete metadata[MONITORED_VOL_COLD_SINCE_METADATA_KEY];
  delete metadata[MONITORED_VOL_HOT_SINCE_METADATA_KEY];
  delete metadata.monitoredVolHotVolume5m;
  metadata.monitoredVolColdInterruptedAt = new Date(nowMs).toISOString();
  metadata.monitoredVolColdInterruptedVolume5m = current;
  return { metadata, changed: true };
}

module.exports = {
  MONITORED_VOL_COLD_HOT_BLIP_GRACE_MS,
  MONITORED_VOL_COLD_RESET_DURATION_MS,
  MONITORED_VOL_COLD_RESET_MAX_VOLUME_5M,
  SURGE_1H_RESET_DRAWDOWN_DURATION_MS,
  SURGE_1H_RESET_DRAWDOWN_RATIO,
  SURGE_1H_RESET_PCHANGE_DURATION_MS,
  SURGE_1H_RESET_PCHANGE_THRESHOLD_RATIO,
  SURGE_6H_RESET_DRAWDOWN_DURATION_MS,
  SURGE_6H_RESET_DRAWDOWN_RATIO,
  SURGE_6H_RESET_MAX_PCHANGE_PCT,
  SURGE_6H_RESET_PCHANGE_DURATION_MS,
  buildMonitoredVolColdMetadata,
  buildSurgePostAlertHighMetadata,
  buildSurgeResetMetadata,
  isMonitoredVolAnchorExpired,
  isSurgeAnchorExpired,
};
