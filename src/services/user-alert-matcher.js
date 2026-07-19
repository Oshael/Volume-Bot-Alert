const db = require('../models/db');
const tokenMarketBucket1m = require('../models/token-market-bucket-1m');
const tokenMarketVolumeBucket1m = require('../models/token-market-volume-bucket-1m');
const tokenMeteoraState = require('../models/token-meteora-state');
const userAlertEvent = require('../models/user-alert-event');
const userAlertRuleState = require('../models/user-alert-rule-state');
const userCustomAlertRule = require('../models/user-custom-alert-rule');
const backendAlertPublisher = require('./backend-alert-publisher');
const alertTickerPeers = require('./alert-ticker-peers');
const { evaluateCustomAlertRule } = require('./custom-alert-rule-evaluator');
const tokenAlertSignalBuilder = require('./token-alert-signal-builder');
const userAlertProfileCache = require('./user-alert-profile-cache');
const { normalizeSocialLinkFields } = require('../utils/dex-social-links');
const { normalizeTokenChain } = require('../utils/token-identity');
const standardAlertReset = require('./standard-alert-reset');
const standardTransition = require('./standard-alert-transition');
const {
  MONITORED_VOL_COLD_RESET_DURATION_MS,
  MONITORED_VOL_COLD_HOT_BLIP_GRACE_MS,
  MONITORED_VOL_COLD_RESET_MAX_VOLUME_5M,
  SURGE_6H_RESET_MAX_PCHANGE_PCT,
  SURGE_6H_RESET_PCHANGE_DURATION_MS,
  SURGE_6H_RESET_DRAWDOWN_RATIO,
  SURGE_6H_RESET_DRAWDOWN_DURATION_MS,
  SURGE_1H_RESET_PCHANGE_THRESHOLD_RATIO,
  SURGE_1H_RESET_PCHANGE_DURATION_MS,
  SURGE_1H_RESET_DRAWDOWN_RATIO,
  SURGE_1H_RESET_DRAWDOWN_DURATION_MS,
} = standardAlertReset;

const ALERT_CHAIN = 'solana';
const STANDARD_ALERT_COOLDOWN_MS = 60 * 1000;
const SURGE_CROSS_WINDOW_COOLDOWN_MS = 60 * 60 * 1000;
const SURGE_1H_MIN_MCAP = 45_000;
const SURGE_6H_MIN_MCAP = 40_000;
const SURGE_STARTUP_SUPPRESS_MS = 60 * 1000;
const SURGE_POST_ALERT_REPEAT_GROWTH_PCT = 50;
const SURGE_6H_REPEAT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const SURGE_CONTINUATION_6H_RULE_KEY = 'surge-continuation-6h';
const SURGE_CONTINUATION_6H_MCAP_MULTIPLIER = 3;
const SURGE_CONTINUATION_6H_MIN_BASE_ALERT_AGE_MS = 60 * 60 * 1000;
const SURGE_CONTINUATION_6H_BASE_EVENT_METADATA_KEY = 'surgeContinuation6hLastBaseEventId';
const SURGE_PRIMED_ACTIVITY_PROOF_STEP_PCT_BY_WINDOW = Object.freeze({
  '1H': 10,
  '6H': 10,
});
const METEORA_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const METEORA_STARTUP_SUPPRESS_MS = 60 * 1000;
const METEORA_PRIMED_ACTIVITY_PROOF_STEP_PCT = 10;
const METEORA_POST_ALERT_REPEAT_STEP_PCT = 50;
const METEORA_REPEAT_TVL_GROWTH_PCT = 15;
const METEORA_FINGERPRINT_CHANGE_BUCKET_PCT = 5;
const METEORA_FINGERPRINT_TVL_BUCKET_USD = 10_000;
const SOLANA_SURGE_VALUATION_KEYS = Object.freeze({
  lastAlerted: 'lastAlertedMcap',
  high: 'surgePostAlertHighMcap',
  interrupted: 'surgeResetDrawdownInterruptedMcap',
});
const GMGN_VOL_1M_RULE_KEY = 'gmgn-vol-1m';
const GMGN_VOL_1M_ALERT_THRESHOLD_PCT = 50;
const GMGN_VOL_1M_ALERT_COOLDOWN_MS = 60 * 1000;
const GMGN_VOL_1M_REPEAT_STEP_PCT = 50;
const GMGN_VOL_1M_ALERT_ENABLED = false;
const CUSTOM_ALERT_RULE_KEY = 'custom-alert';
const MATCHER_RULE_KEYS = Object.freeze([
  'monitored-vol',
  GMGN_VOL_1M_RULE_KEY,
  'monitored-mcap',
  'hvnc',
  'recent-surge-1h',
  'recent-surge-6h',
  'old-week-surge-1h',
  'old-week-surge-6h',
  'meteora-surge',
]);
const SURGE_RULE_KEYS = Object.freeze([
  'recent-surge-1h',
  'recent-surge-6h',
  'old-week-surge-1h',
  'old-week-surge-6h',
]);
const RULE_ENABLED_FIELD_BY_KEY = Object.freeze({
  'monitored-vol': 'monitoredVol',
  [GMGN_VOL_1M_RULE_KEY]: 'monitoredVol',
  'monitored-mcap': 'monitoredMcap',
  hvnc: 'hvnc',
  'recent-surge-1h': 'recentSurge1h',
  'recent-surge-6h': 'recentSurge6h',
  'old-week-surge-1h': 'oldWeekSurge1h',
  'old-week-surge-6h': 'oldWeekSurge6h',
  'meteora-surge': 'meteoraSurge',
});
const REARM_PRESERVE_COOLDOWN_RULE_KEYS = new Set([
  'monitored-vol',
  GMGN_VOL_1M_RULE_KEY,
  'monitored-mcap',
  'meteora-surge',
]);
const ANCHORED_REPEAT_RULE_KEYS = new Set([
  'monitored-vol',
  GMGN_VOL_1M_RULE_KEY,
  'monitored-mcap',
]);

function toNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function hasNumericInput(value) {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return false;
  }
  return Number.isFinite(Number(value));
}

function toTextOrNull(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function toTimestampMs(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
}

function toProfileLoadedAtMs(profile) {
  return toTimestampMs(profile?.loadedAt);
}

function toProfileLoadedAtIso(profile) {
  return toTextOrNull(profile?.loadedAt);
}

function toProfilePresenceMode(profile) {
  return toTextOrNull(profile?.presenceMode);
}

function toProfileHiddenSessionKey(profile) {
  return toTextOrNull(profile?.hiddenSessionKey);
}

function roundAlertMetric(value) {
  const num = toNumberOrNull(value);
  if (num == null) {
    return 'na';
  }
  return String(Math.round(num * 100) / 100);
}

function buildFingerprint(parts = []) {
  return parts.map((part) => roundAlertMetric(part)).join('|');
}

function bucketMetric(value, bucketSize) {
  const num = toNumberOrNull(value);
  const bucket = Number(bucketSize);
  if (num == null || !(bucket > 0)) {
    return roundAlertMetric(value);
  }

  return String(Math.floor(num / bucket) * bucket);
}

function createEmptySummary() {
  return {
    evaluatedProfiles: 0,
    emitted: 0,
    rearmed: 0,
    suppressed: 0,
    errors: 0,
    events: [],
  };
}

function resolveDisplaySymbol(tokenAfter, address) {
  return toTextOrNull(tokenAfter?.symbol) || address.slice(0, 8);
}

function buildSharedPayload(tokenAfter, signals) {
  const address = String(tokenAfter?.address || '').trim();
  const socialLinks = normalizeSocialLinkFields({
    twitterUrl: tokenAfter?.last_twitter_url,
    communityUrl: tokenAfter?.last_community_url,
  });
  return {
    address,
    symbol: resolveDisplaySymbol(tokenAfter, address),
    name: toTextOrNull(tokenAfter?.name),
    pairAddress: toTextOrNull(tokenAfter?.last_pair_address),
    pairUrl: toTextOrNull(tokenAfter?.last_pair_url),
    imageUrl: toTextOrNull(tokenAfter?.last_image_url),
    twitterUrl: socialLinks.twitterUrl,
    communityUrl: socialLinks.communityUrl,
    tokenCreatedAt: toNumberOrNull(tokenAfter?.last_token_created_at_ms),
    prevVolume1m: signals.prevVolume1m,
    volume1m: signals.currentVolume1m,
    prevVolume5m: signals.prevVolume5m,
    volume5m: signals.currentVolume5m,
    volume1h: toNumberOrNull(tokenAfter?.last_vol_1h),
    volume6h: toNumberOrNull(tokenAfter?.last_vol_6h),
    volume24h: signals.volume24h,
    prevMcap: signals.prevMcap,
    mcap: signals.currentMcap,
    priceChange1h: signals.currentPriceChange1h,
    priceChange6h: signals.currentPriceChange6h,
  };
}

function getCustomAlertMetricLabel(metric) {
  return metric === 'price' ? 'Price' : 'Market Cap';
}

function getCustomAlertOperatorLabel() {
  return 'hits';
}

function buildSolanaCustomAlertObservation(token, fallbackObservedAtMs = null) {
  if (!token?.address) return null;
  const persistedObservedAtMs = toTimestampMs(
    token.last_evaluated_at ?? token.lastEvaluatedAt,
  );
  const observedAtMs = persistedObservedAtMs
    ?? (Number.isFinite(fallbackObservedAtMs) ? fallbackObservedAtMs : null);
  if (observedAtMs == null) return null;
  return {
    chain: ALERT_CHAIN,
    address: token.address,
    observedAt: new Date(observedAtMs).toISOString(),
    values: {
      price: toNumberOrNull(token.last_price ?? token.price ?? token.priceUsd),
      mcap: toNumberOrNull(token.last_mcap ?? token.mcap ?? token.marketCap),
    },
  };
}

function buildCustomAlertPayload(rule, tokenBefore, tokenAfter, currentValue, previousValue) {
  const address = String(tokenAfter?.address || rule?.tokenAddress || '').trim();
  const shared = buildSharedPayload(tokenAfter, {
    prevVolume1m: null,
    currentVolume1m: null,
    prevVolume5m: null,
    currentVolume5m: toNumberOrNull(tokenAfter?.last_vol_5m),
    volume24h: toNumberOrNull(tokenAfter?.last_vol_24h),
    prevMcap: toNumberOrNull(tokenBefore?.last_mcap),
    currentMcap: toNumberOrNull(tokenAfter?.last_mcap),
    currentPriceChange1h: readPriceChange(tokenAfter, '1h'),
    currentPriceChange6h: readPriceChange(tokenAfter, '6h'),
  });

  return {
    ...shared,
    address,
    label: 'CUSTOM',
    pct: null,
    customRuleId: rule.id,
    customColorHex: rule.colorHex,
    customTitle: rule.title,
    customMetric: getCustomAlertMetricLabel(rule.metric),
    customOperator: getCustomAlertOperatorLabel(rule.operator),
    customTarget: rule.targetValue,
    customRepeatMode: 'trigger once',
    customExpires: rule.expiresAt || 'never',
    customFilters: 'none',
    customSoundName: rule.soundName,
    customSoundDataUrl: rule.soundDataUrl,
    customCurrentValue: currentValue,
    customPreviousValue: previousValue,
  };
}

function readEnvNumber(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readEnvBoolean(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') {
    return fallback;
  }
  return raw === 'true' || raw === '1';
}

function passesCommonAlertFilters(profile, signals) {
  const currentVolume5m = toNumberOrNull(signals.currentVolume5m) || 0;
  const currentMcap = toNumberOrNull(signals.currentMcap) || 0;

  if (currentVolume5m < (toNumberOrNull(profile?.minVol) || 0)) {
    return false;
  }
  if (currentMcap > 0 && currentMcap < (toNumberOrNull(profile?.minMcap) || 0)) {
    return false;
  }

  const maxMcap = toNumberOrNull(profile?.maxMcap) || 0;
  if (maxMcap > 0 && currentMcap > maxMcap) {
    return false;
  }

  return true;
}

function buildHvncCandidate(profile, shared, signals) {
  const qualifies = signals.passesHvncPrereqs
    && signals.volume24h != null
    && signals.volume24h >= (toNumberOrNull(profile.hvncMinVol) || 0);
  if (!qualifies) {
    return null;
  }

  return {
    ruleKey: 'hvnc',
    kind: 'hvnc',
    label: 'HVNC',
    pct: 0,
    lastAlertedValue: signals.volume24h,
    cooldownMs: 0,
    repeatStepPct: null,
    fingerprint: buildFingerprint(['hvnc', signals.volume24h, signals.tokenCreatedAt]),
    payload: {
      ...shared,
      isHvnc: true,
    },
  };
}

function buildMeteoraCandidate(profile, shared, signals) {
  const qualifies = signals.passesMeteoraPrereqs
    && signals.meteoraChange1h != null
    && signals.meteoraChange1h >= (toNumberOrNull(profile.meteoraAlert1hThreshold) || 0);
  if (!qualifies) {
    return null;
  }

  return {
    ruleKey: 'meteora-surge',
    kind: 'meteora-surge',
    label: 'METEORA 1H',
    pct: signals.meteoraChange1h,
    lastAlertedValue: signals.meteoraCurrentTvl,
    cooldownMs: METEORA_ALERT_COOLDOWN_MS,
    repeatStepPct: null,
    fingerprint: buildFingerprint([
      'meteora-surge',
      bucketMetric(signals.meteoraChange1h, METEORA_FINGERPRINT_CHANGE_BUCKET_PCT),
      bucketMetric(signals.meteoraCurrentTvl, METEORA_FINGERPRINT_TVL_BUCKET_USD),
      toTextOrNull(signals.meteoraBestPoolAddress),
    ]),
    startupSuppressUntilMs: (() => {
      const loadedAtMs = toProfileLoadedAtMs(profile);
      return loadedAtMs != null ? loadedAtMs + METEORA_STARTUP_SUPPRESS_MS : null;
    })(),
    payload: {
      ...shared,
      meteoraCurrentTvl: signals.meteoraCurrentTvl,
      meteoraBaselineTvl24h: signals.meteoraBaselineTvl24h,
    },
  };
}

function estimateSurgeBaselineMcap(currentMcap, priceChangePct) {
  const current = toNumberOrNull(currentMcap);
  const pct = toNumberOrNull(priceChangePct);
  const ratio = pct == null ? null : 1 + (pct / 100);
  if (!(current > 0) || !(ratio > 0)) {
    return null;
  }
  return current / ratio;
}

function getInternalSurgeWindowState(signals, surgeWindow) {
  if (surgeWindow === '6H') {
    return {
      available: signals?.internalSurge6hAvailable === true,
      currentMcap: toNumberOrNull(signals?.internalSurgeCurrentMcap),
      currentTs: toTextOrNull(signals?.internalSurgeCurrentTs),
      baselineMcap: toNumberOrNull(signals?.internalSurgeBaseline6hMcap),
      baselineTs: toTextOrNull(signals?.internalSurgeBaseline6hTs),
      priceChangePct: toNumberOrNull(signals?.internalPriceChange6h),
    };
  }

  return {
    available: signals?.internalSurge1hAvailable === true,
    currentMcap: toNumberOrNull(signals?.internalSurgeCurrentMcap),
    currentTs: toTextOrNull(signals?.internalSurgeCurrentTs),
    baselineMcap: toNumberOrNull(signals?.internalSurgeBaseline1hMcap),
    baselineTs: toTextOrNull(signals?.internalSurgeBaseline1hTs),
    priceChangePct: toNumberOrNull(signals?.internalPriceChange1h),
  };
}

function getSurgeWindowPctInputs(signals, surgeWindow) {
  return surgeWindow === '6H'
    ? {
        currentPctInput: signals.currentPriceChange6h,
        previousPctInput: signals.prevPriceChange6h,
      }
    : {
        currentPctInput: signals.currentPriceChange1h,
        previousPctInput: signals.prevPriceChange1h,
      };
}

function getSurgeAgeGatePassed(signals, ageBucket, surgeWindow) {
  if (ageBucket !== 'recent') {
    return signals.oldWeekSurgeAgeGatePassed;
  }

  if (surgeWindow === '1H') {
    return signals.recentSurge1hAgeGatePassed ?? signals.recentSurgeAgeGatePassed;
  }

  return signals.recentSurge6hAgeGatePassed ?? signals.recentSurgeAgeGatePassed;
}

function qualifiesForSurgeCandidate(input) {
  return Boolean(input.enabled)
    && input.ageGatePassed
    && input.currentPct != null
    && input.thresholdPct != null
    && (toNumberOrNull(input.currentMcap) || 0) >= input.minMcap
    && input.currentPct >= input.thresholdPct;
}

function didSurgeCrossThreshold(input) {
  return hasNumericInput(input.previousPctInput)
    && input.previousPct != null
    && input.thresholdPct != null
    && input.previousPct < input.thresholdPct
    && input.currentPct >= input.thresholdPct;
}

function buildSurgeBaselinePayload(internalSurge, currentMcap, currentPct) {
  if (internalSurge.available) {
    return {
      prevMcap: internalSurge.baselineMcap,
      surgeBaselineMcapEstimated: false,
      surgeMetricSource: 'market-buckets-1m',
      surgeBaselineMcap: internalSurge.baselineMcap,
      surgeBaselineTs: internalSurge.baselineTs,
      surgeCurrentMcap: internalSurge.currentMcap,
      surgeCurrentTs: internalSurge.currentTs,
    };
  }

  const estimatedBaselineMcap = estimateSurgeBaselineMcap(currentMcap, currentPct);
  return {
    prevMcap: estimatedBaselineMcap,
    surgeBaselineMcapEstimated: estimatedBaselineMcap != null,
    surgeMetricSource: 'catalog-price-change',
    surgeBaselineMcap: null,
    surgeBaselineTs: null,
    surgeCurrentMcap: null,
    surgeCurrentTs: null,
  };
}

function buildSurgeCandidate(input) {
  const {
    profile,
    enabled,
    thresholdPct,
    ruleKey,
    ageBucket,
    surgeWindow,
    shared,
    signals,
  } = input;
  const { currentPctInput, previousPctInput } = getSurgeWindowPctInputs(signals, surgeWindow);
  const internalSurge = getInternalSurgeWindowState(signals, surgeWindow);
  const currentPct = toNumberOrNull(currentPctInput);
  const previousPct = toNumberOrNull(previousPctInput);
  const normalizedThresholdPct = toNumberOrNull(thresholdPct) ?? null;
  const ageGatePassed = getSurgeAgeGatePassed(signals, ageBucket, surgeWindow);
  const minMcap = surgeWindow === '6H' ? SURGE_6H_MIN_MCAP : SURGE_1H_MIN_MCAP;
  if (!qualifiesForSurgeCandidate({
    enabled,
    ageGatePassed,
    currentPct,
    thresholdPct: normalizedThresholdPct,
    currentMcap: signals.currentMcap,
    minMcap,
  })) {
    return null;
  }

  const crossedThreshold = didSurgeCrossThreshold({
    previousPctInput,
    previousPct,
    currentPct,
    thresholdPct: normalizedThresholdPct,
  });
  const baselinePayload = buildSurgeBaselinePayload(internalSurge, signals.currentMcap, currentPct);

  return {
    ruleKey,
    kind: 'old-surge',
    label: `PCHANGE ${surgeWindow}`,
    pct: currentPct,
    lastAlertedValue: currentPct,
    cooldownMs: surgeWindow === '6H' ? SURGE_6H_REPEAT_COOLDOWN_MS : 0,
    repeatStepPct: null,
    fingerprint: buildFingerprint([ruleKey, previousPct, currentPct, signals.currentMcap, signals.volume24h]),
    crossedThreshold,
    primeOnFirstSeen: !crossedThreshold && !internalSurge.available,
    startupSuppressUntilMs: (() => {
      const loadedAtMs = toProfileLoadedAtMs(profile);
      return loadedAtMs != null ? loadedAtMs + SURGE_STARTUP_SUPPRESS_MS : null;
    })(),
    payload: {
      ...shared,
      ...baselinePayload,
      ageBucket,
      isOldSurge: true,
      surgeWindow,
      thresholdPct: normalizedThresholdPct,
      tokenAgeMs: toNumberOrNull(signals.ageMs),
    },
  };
}

function buildMonitoredVolCandidate(profile, shared, signals) {
  const qualifies = signals.hasVol5mBaseline
    && signals.vol5mChangePct != null
    && signals.vol5mChangePct >= (toNumberOrNull(profile.thresholdPct) || 0)
    && passesCommonAlertFilters(profile, signals)
    && !signals.isMcapDeclining;
  if (!qualifies) {
    return null;
  }

  return {
    ruleKey: 'monitored-vol',
    kind: 'monitored-vol',
    label: 'VOL',
    pct: signals.vol5mChangePct,
    lastAlertedValue: signals.currentVolume5m,
    cooldownMs: STANDARD_ALERT_COOLDOWN_MS,
    repeatStepPct: toNumberOrNull(profile?.thresholdPct) || 0,
    fingerprint: buildFingerprint([signals.vol5mChangePct, signals.prevVolume5m, signals.currentVolume5m]),
    payload: shared,
  };
}

function buildGmgnVol1mCandidate(profile, shared, signals) {
  if (!readEnvBoolean('GMGN_VOL_1M_ALERT_ENABLED', GMGN_VOL_1M_ALERT_ENABLED)) {
    return null;
  }

  const thresholdPct = readEnvNumber('GMGN_VOL_1M_ALERT_THRESHOLD_PCT', GMGN_VOL_1M_ALERT_THRESHOLD_PCT);
  const qualifies = signals.alertSource === 'gmgn'
    && signals.hasVol1mBaseline
    && signals.vol1mChangePct != null
    && signals.vol1mChangePct >= thresholdPct
    && passesCommonAlertFilters(profile, signals)
    && !signals.isMcapDeclining;
  if (!qualifies) {
    return null;
  }

  return {
    ruleKey: GMGN_VOL_1M_RULE_KEY,
    kind: 'monitored-vol',
    label: 'GMGN 1M',
    pct: signals.vol1mChangePct,
    lastAlertedValue: signals.currentVolume1m,
    cooldownMs: readEnvNumber('GMGN_VOL_1M_ALERT_COOLDOWN_MS', GMGN_VOL_1M_ALERT_COOLDOWN_MS),
    repeatStepPct: readEnvNumber('GMGN_VOL_1M_REPEAT_STEP_PCT', GMGN_VOL_1M_REPEAT_STEP_PCT),
    fingerprint: buildFingerprint([GMGN_VOL_1M_RULE_KEY, signals.vol1mChangePct, signals.prevVolume1m, signals.currentVolume1m]),
    payload: {
      ...shared,
      source: 'gmgn',
      gmgnInterval: '1m',
      thresholdPct,
      prevVolume1m: signals.prevVolume1m,
      volume1m: signals.currentVolume1m,
      volume5m: signals.currentVolume5m,
    },
  };
}

function buildMonitoredMcapCandidate(profile, shared, signals) {
  const qualifies = signals.hasMcapBaseline
    && signals.mcapAlertTokenAgeGatePassed
    && signals.mcapChangePct != null
    && signals.mcapChangePct >= (toNumberOrNull(profile.mcapThresholdPct) || 0)
    && passesCommonAlertFilters(profile, signals);
  if (!qualifies) {
    return null;
  }

  return {
    ruleKey: 'monitored-mcap',
    kind: 'monitored-mcap',
    label: 'MCAP',
    pct: signals.mcapChangePct,
    lastAlertedValue: signals.currentMcap,
    cooldownMs: STANDARD_ALERT_COOLDOWN_MS,
    repeatStepPct: toNumberOrNull(profile?.mcapThresholdPct) || 0,
    fingerprint: buildFingerprint([signals.mcapChangePct, signals.prevMcap, signals.currentMcap]),
    payload: shared,
  };
}

function buildSurgeCandidates(profile, shared, signals) {
  if (signals.recentSurge1hAgeGatePassed || signals.recentSurge6hAgeGatePassed || signals.recentSurgeAgeGatePassed) {
    return [
      buildSurgeCandidate({
        profile,
        enabled: profile?.ruleEnabled?.recentSurge6h,
        thresholdPct: profile?.recentSurge6hThresholdPct,
        ruleKey: 'recent-surge-6h',
        ageBucket: 'recent',
        surgeWindow: '6H',
        shared,
        signals,
      }),
      buildSurgeCandidate({
        profile,
        enabled: profile?.ruleEnabled?.recentSurge1h,
        thresholdPct: profile?.recentSurge1hThresholdPct,
        ruleKey: 'recent-surge-1h',
        ageBucket: 'recent',
        surgeWindow: '1H',
        shared,
        signals,
      }),
    ];
  }

  if (signals.oldWeekSurgeAgeGatePassed) {
    return [
      buildSurgeCandidate({
        profile,
        enabled: profile?.ruleEnabled?.oldWeekSurge6h,
        thresholdPct: profile?.oldWeekSurge6hThresholdPct,
        ruleKey: 'old-week-surge-6h',
        ageBucket: 'old-week',
        surgeWindow: '6H',
        shared,
        signals,
      }),
      buildSurgeCandidate({
        profile,
        enabled: profile?.ruleEnabled?.oldWeekSurge1h,
        thresholdPct: profile?.oldWeekSurge1hThresholdPct,
        ruleKey: 'old-week-surge-1h',
        ageBucket: 'old-week',
        surgeWindow: '1H',
        shared,
        signals,
      }),
    ];
  }

  return [];
}

function buildRuleCandidate(profile, tokenAfter, signals) {
  const shared = buildSharedPayload(tokenAfter, signals);
  const candidates = [];

  if (profile?.ruleEnabled?.hvnc) {
    candidates.push(buildHvncCandidate(profile, shared, signals));
  }
  candidates.push(...buildSurgeCandidates(profile, shared, signals));
  if (profile?.ruleEnabled?.meteoraSurge) {
    candidates.push(buildMeteoraCandidate(profile, shared, signals));
  }
  if (profile?.ruleEnabled?.monitoredVol) {
    candidates.push(buildGmgnVol1mCandidate(profile, shared, signals));
    candidates.push(buildMonitoredVolCandidate(profile, shared, signals));
  }
  if (profile?.ruleEnabled?.monitoredMcap) {
    candidates.push(buildMonitoredMcapCandidate(profile, shared, signals));
  }

  const qualifiedCandidates = candidates.filter(Boolean);
  return {
    candidate: qualifiedCandidates.find((candidate) => candidate.ruleKey !== GMGN_VOL_1M_RULE_KEY) || qualifiedCandidates[0] || null,
    candidates: buildLifecycleCandidates(qualifiedCandidates),
    qualifiedRuleKeys: qualifiedCandidates.map((candidate) => candidate.ruleKey),
  };
}

function buildLifecycleCandidates(qualifiedCandidates = []) {
  const primary = qualifiedCandidates.find((candidate) => candidate.ruleKey !== GMGN_VOL_1M_RULE_KEY) || null;
  const gmgnVol1m = qualifiedCandidates.find((candidate) => candidate.ruleKey === GMGN_VOL_1M_RULE_KEY) || null;
  return [primary, gmgnVol1m].filter(Boolean);
}

function buildRearmRuleKeys(profile, qualifiedRuleKeys = []) {
  const qualifiedSet = new Set(qualifiedRuleKeys);

  return MATCHER_RULE_KEYS.filter((ruleKey) => {
    if (qualifiedSet.has(ruleKey)) {
      return false;
    }
    const fieldName = RULE_ENABLED_FIELD_BY_KEY[ruleKey];
    return fieldName ? Boolean(profile?.ruleEnabled?.[fieldName]) : false;
  });
}

function needsVolumeBaseline(profiles = []) {
  return profiles.some((profile) => profile?.ruleEnabled?.monitoredVol);
}

function needsGmgnVolume1mBaseline(profiles = [], context = {}) {
  return context.alertSource === 'gmgn'
    && profiles.some((profile) => profile?.ruleEnabled?.monitoredVol);
}

function needsMcapBaseline(profiles = []) {
  return profiles.some((profile) => profile?.ruleEnabled?.monitoredMcap);
}

function needsSurgeBaseline(profiles = []) {
  return profiles.some((profile) => profile?.ruleEnabled?.recentSurge1h
    || profile?.ruleEnabled?.recentSurge6h
    || profile?.ruleEnabled?.oldWeekSurge1h
    || profile?.ruleEnabled?.oldWeekSurge6h);
}

function needsMeteoraState(profiles = []) {
  return profiles.some((profile) => profile?.ruleEnabled?.meteoraSurge);
}

function mergeVolumeRows(vol5mRow, vol1mRow) {
  if (!vol5mRow && !vol1mRow) {
    return null;
  }
  return {
    ...(vol5mRow || {}),
    ...(vol1mRow || {}),
    token_address: vol5mRow?.token_address || vol1mRow?.token_address || null,
  };
}

async function loadVolumeRows(address, profiles, deps, context = {}) {
  if (!needsVolumeBaseline(profiles)) {
    return [];
  }

  const [vol5mRows, vol1mRows] = await Promise.all([
    deps.tokenMarketVolumeBucket1m.listCurrentAndBaselineByAddresses([address], 5),
    needsGmgnVolume1mBaseline(profiles, context)
      ? deps.tokenMarketVolumeBucket1m.listCurrentAndBaselineByAddresses([address], 1, { volumeWindow: '1m' })
      : [],
  ]);
  const merged = mergeVolumeRows(vol5mRows[0] || null, vol1mRows[0] || null);
  return merged ? [merged] : [];
}

async function loadMcapRows(address, profiles, deps) {
  if (!needsMcapBaseline(profiles)) {
    return [];
  }

  return deps.tokenMarketBucket1m.listCurrentAndBaselineByAddresses([address], 5);
}

async function loadSurgeRows(address, profiles, deps) {
  if (!needsSurgeBaseline(profiles)
    || typeof deps.tokenMarketBucket1m.listCurrentAndWindowBaselinesByAddresses !== 'function') {
    return [];
  }

  return deps.tokenMarketBucket1m.listCurrentAndWindowBaselinesByAddresses([address], [60, 360]);
}

async function loadMeteoraRows(address, profiles, deps) {
  if (!needsMeteoraState(profiles)) {
    return [];
  }

  return deps.tokenMeteoraState.listSummaryByAddresses([address]);
}

function buildMigrationSignalInput(tokenAfter) {
  return {
    source: tokenAfter?.source,
    first_seen_at: tokenAfter?.first_seen_at,
    migration_grace_until: tokenAfter?.migration_grace_until,
  };
}

function readPriceChange(token, window) {
  if (window === '1h') {
    return token?.last_price_change_1h ?? token?.priceChange1h ?? null;
  }
  return token?.last_price_change_6h ?? token?.priceChange6h ?? null;
}

function buildVolumeSignalInput(tokenBefore, tokenAfter, volumeRow) {
  return {
    last_vol_1m: volumeRow?.current_vol_1m ?? volumeRow?.current_volume_1m ?? null,
    baseline_vol_1m: volumeRow?.baseline_vol_1m ?? null,
    last_vol_5m: tokenAfter?.last_vol_5m,
    baseline_vol_5m: volumeRow?.baseline_vol_5m ?? tokenBefore?.last_vol_5m ?? null,
    last_vol_24h: tokenAfter?.last_vol_24h,
  };
}

function buildMcapSignalInput(tokenBefore, tokenAfter, mcapRow, surgeRow) {
  return {
    last_mcap: mcapRow?.current_mcap ?? surgeRow?.current_mcap ?? tokenAfter?.last_mcap,
    baseline_mcap: mcapRow?.baseline_mcap ?? tokenBefore?.last_mcap ?? null,
  };
}

function buildInternalSurgeSignalInput(surgeRow) {
  return {
    internal_surge_current_ts: surgeRow?.current_ts ?? null,
    internal_surge_current_mcap: surgeRow?.current_mcap ?? null,
    internal_surge_baseline_1h_ts: surgeRow?.baseline_60m_ts ?? null,
    internal_surge_baseline_1h_mcap: surgeRow?.baseline_60m_mcap ?? null,
    internal_surge_baseline_6h_ts: surgeRow?.baseline_360m_ts ?? null,
    internal_surge_baseline_6h_mcap: surgeRow?.baseline_360m_mcap ?? null,
  };
}

function buildPriceChangeSignalInput(tokenBefore, tokenAfter) {
  return {
    last_price_change_1h: readPriceChange(tokenAfter, '1h'),
    baseline_price_change_1h: readPriceChange(tokenBefore, '1h'),
    last_price_change_6h: readPriceChange(tokenAfter, '6h'),
    baseline_price_change_6h: readPriceChange(tokenBefore, '6h'),
  };
}

function buildCoreSignalInput(tokenBefore, tokenAfter, volumeRow, mcapRow, surgeRow, context = {}) {
  return {
    tokenAddress: String(tokenAfter?.address || '').trim(),
    alertSource: toTextOrNull(context.alertSource),
    ...buildMigrationSignalInput(tokenAfter),
    ...buildVolumeSignalInput(tokenBefore, tokenAfter, volumeRow),
    ...buildMcapSignalInput(tokenBefore, tokenAfter, mcapRow, surgeRow),
    ...buildInternalSurgeSignalInput(surgeRow),
    last_token_created_at_ms: tokenAfter?.last_token_created_at_ms,
    ...buildPriceChangeSignalInput(tokenBefore, tokenAfter),
  };
}

function buildMeteoraSignalInput(meteoraRow) {
  return {
    meteoraCurrentTvl: meteoraRow?.currentTvl ?? null,
    meteoraBaselineTvl1h: meteoraRow?.baselineTvl1h ?? null,
    meteoraBaselineTvl24h: meteoraRow?.baselineTvl24h ?? null,
    meteoraBestPoolAddress: meteoraRow?.bestPoolAddress ?? null,
    meteoraNoPool: !(meteoraRow?.hasPool === true && (toNumberOrNull(meteoraRow?.currentTvl) || 0) > 0),
  };
}

function buildSignalInput(tokenBefore, tokenAfter, volumeRow, mcapRow, surgeRow, meteoraRow, context = {}) {
  return {
    ...buildCoreSignalInput(tokenBefore, tokenAfter, volumeRow, mcapRow, surgeRow, context),
    ...buildMeteoraSignalInput(meteoraRow),
  };
}

function isCooldownActive(state, nowMs) {
  return standardTransition.isCooldownActive(state, nowMs);
}

function canRepeatCandidate(candidate, state) {
  if (!(toNumberOrNull(candidate?.repeatStepPct) > 0)) {
    return false;
  }

  if (ANCHORED_REPEAT_RULE_KEYS.has(candidate?.ruleKey)) {
    return hasAdvancedRepeatValue(candidate, state);
  }

  const lastAlertedPct = toNumberOrNull(state?.lastAlertedPct);
  return lastAlertedPct != null
    && toNumberOrNull(candidate?.pct) != null
    && candidate.pct >= lastAlertedPct + candidate.repeatStepPct;
}

function hasAdvancedRepeatValue(candidate, state) {
  return standardTransition.hasAdvancedRepeatValue(candidate, state);
}

function isMonitoredVolAnchorExpired(candidate, state, nowMs) {
  return standardAlertReset.isMonitoredVolAnchorExpired(candidate, state, nowMs);
}

function isSixHourSurgeRuleKey(ruleKey) {
  return ruleKey === 'recent-surge-6h' || ruleKey === 'old-week-surge-6h';
}

function isOneHourSurgeRuleKey(ruleKey) {
  return ruleKey === 'recent-surge-1h' || ruleKey === 'old-week-surge-1h';
}

function isResettableSurgeRuleKey(ruleKey) {
  return isOneHourSurgeRuleKey(ruleKey) || isSixHourSurgeRuleKey(ruleKey);
}

function getSurgeThresholdPct(profile, ruleKey) {
  if (ruleKey === 'recent-surge-1h') return toNumberOrNull(profile?.recentSurge1hThresholdPct);
  if (ruleKey === 'old-week-surge-1h') return toNumberOrNull(profile?.oldWeekSurge1hThresholdPct);
  return null;
}

function isSurgeAnchorExpired(candidate, state, nowMs) {
  return standardAlertReset.isSurgeAnchorExpired(candidate, state, nowMs, {
    cooldownActive: isSixHourSurgeCooldownActive(candidate, state, nowMs),
  });
}

function buildSurgeResetMetadata(profile, ruleKey, state, signals, nowMs) {
  return standardAlertReset.buildSurgeResetMetadata({
    ruleKey,
    thresholdPct: getSurgeThresholdPct(profile, ruleKey),
    state,
    observation: {
      valuation: toNumberOrNull(signals?.last_mcap ?? signals?.currentMcap ?? signals?.mcap),
      priceChange1h: toNumberOrNull(signals?.last_price_change_1h ?? signals?.currentPriceChange1h),
      priceChange6h: toNumberOrNull(signals?.last_price_change_6h ?? signals?.currentPriceChange6h),
    },
    nowMs,
    valuationKeys: SOLANA_SURGE_VALUATION_KEYS,
  });
}

function buildSurgePostAlertHighMetadata(ruleKey, state, signals) {
  return standardAlertReset.buildSurgePostAlertHighMetadata({
    ruleKey,
    state,
    valuation: toNumberOrNull(signals?.last_mcap ?? signals?.currentMcap ?? signals?.mcap),
    valuationKeys: SOLANA_SURGE_VALUATION_KEYS,
  });
}

function buildMonitoredVolColdMetadata(state, signals, nowMs) {
  return standardAlertReset.buildMonitoredVolColdMetadata(
    state,
    toNumberOrNull(signals?.currentVolume5m ?? signals?.volume5m ?? signals?.last_vol_5m),
    nowMs,
  );
}

async function syncRearmedMonitoredVolColdState(
  profile,
  tokenAfter,
  ruleKey,
  state,
  signals,
  nowMs,
  deps,
  options = {},
) {
  if (ruleKey !== 'monitored-vol' || state?.status !== 'rearmed') {
    return state;
  }

  if (options.preserveExpiredColdAnchor === true && isMonitoredVolAnchorExpired({ ruleKey }, state, nowMs)) {
    return state;
  }

  const { metadata, changed } = buildMonitoredVolColdMetadata(state, signals, nowMs);
  if (!changed) {
    return state;
  }

  await deps.userAlertRuleState.markRearmed({
    userId: profile.userId,
    ruleKey,
    chain: ALERT_CHAIN,
    tokenAddress: tokenAfter.address,
    cooldownUntil: state.cooldownUntil,
    metadata: {
      ...metadata,
      lastDecision: 'rearmed',
    },
  });

  return {
    ...state,
    metadata: {
      ...metadata,
      lastDecision: 'rearmed',
    },
  };
}

async function syncRearmedSurgeResetState(
  profile,
  tokenAfter,
  ruleKey,
  state,
  signals,
  nowMs,
  deps,
  options = {},
) {
  if (!isResettableSurgeRuleKey(ruleKey) || state?.status !== 'rearmed') {
    return state;
  }

  if (options.preserveExpiredSurgeAnchor === true && isSurgeAnchorExpired({ ruleKey }, state, nowMs)) {
    return state;
  }

  const { metadata, changed } = buildSurgeResetMetadata(profile, ruleKey, state, signals, nowMs);
  if (!changed) {
    return state;
  }

  await deps.userAlertRuleState.markRearmed({
    userId: profile.userId,
    ruleKey,
    chain: ALERT_CHAIN,
    tokenAddress: tokenAfter.address,
    cooldownUntil: state.cooldownUntil,
    metadata: {
      ...metadata,
      lastDecision: 'rearmed',
    },
  });

  return {
    ...state,
    metadata: {
      ...metadata,
      lastDecision: 'rearmed',
    },
  };
}

async function syncRearmedResetState(
  profile,
  tokenAfter,
  ruleKey,
  state,
  signals,
  nowMs,
  deps,
  options = {},
) {
  const volState = await syncRearmedMonitoredVolColdState(
    profile,
    tokenAfter,
    ruleKey,
    state,
    signals,
    nowMs,
    deps,
    options,
  );
  return syncRearmedSurgeResetState(
    profile,
    tokenAfter,
    ruleKey,
    volState,
    signals,
    nowMs,
    deps,
    options,
  );
}

async function syncTriggeredSurgePostAlertHighState(
  profile,
  tokenAfter,
  ruleKey,
  state,
  signals,
  deps,
) {
  if (!isResettableSurgeRuleKey(ruleKey)
    || state?.status !== 'triggered'
    || toTimestampMs(state?.lastAlertedAt) == null) {
    return state;
  }

  const { metadata, changed } = buildSurgePostAlertHighMetadata(ruleKey, state, signals);
  if (!changed) {
    return state;
  }

  await deps.userAlertRuleState.markTriggered({
    userId: profile.userId,
    ruleKey,
    chain: ALERT_CHAIN,
    tokenAddress: tokenAfter.address,
    lastAlertedAt: state.lastAlertedAt,
    lastAlertedValue: state.lastAlertedValue,
    lastAlertedPct: state.lastAlertedPct,
    cooldownUntil: state.cooldownUntil,
    rearmRequired: state.rearmRequired,
    lastFingerprint: state.lastFingerprint,
    metadata,
  });

  return {
    ...state,
    metadata,
  };
}

function shouldPrimeCandidate(candidate, state, nowMs) {
  if (state) {
    return false;
  }

  const startupSuppressUntilMs = toNumberOrNull(candidate?.startupSuppressUntilMs);
  if (startupSuppressUntilMs != null && nowMs < startupSuppressUntilMs) {
    return true;
  }

  return Boolean(candidate?.primeOnFirstSeen);
}

function isSameSurgeSessionState(candidate, state, profile) {
  if (candidate?.kind !== 'old-surge' || !state) {
    return false;
  }

  const profileLoadedAt = toProfileLoadedAtIso(profile);
  const stateSessionStartedAt = toTextOrNull(state?.metadata?.sessionStartedAt);
  return Boolean(profileLoadedAt && stateSessionStartedAt && profileLoadedAt === stateSessionStartedAt);
}

function isSixHourSurgeCandidate(candidate) {
  return candidate?.kind === 'old-surge' && candidate?.payload?.surgeWindow === '6H';
}

function isSixHourSurgeCooldownActive(candidate, state, nowMs) {
  if (!isSixHourSurgeCandidate(candidate) && !isSixHourSurgeRuleKey(candidate?.ruleKey)) {
    return false;
  }

  const lastAlertedAtMs = toTimestampMs(state?.lastAlertedAt);
  return lastAlertedAtMs != null && (nowMs - lastAlertedAtMs) < SURGE_6H_REPEAT_COOLDOWN_MS;
}

function hasRequiredSurgePctAdvance(candidate, state) {
  return standardTransition.hasRequiredSurgePctAdvance(candidate, state, {
    primedStepPct: SURGE_PRIMED_ACTIVITY_PROOF_STEP_PCT_BY_WINDOW[candidate?.payload?.surgeWindow],
    postAlertGrowthPct: SURGE_POST_ALERT_REPEAT_GROWTH_PCT,
  });
}

function canRepeatSurgeInSession(candidate, state) {
  return standardTransition.canRepeatSurgeInSession(candidate, state, {
    primedStepPct: SURGE_PRIMED_ACTIVITY_PROOF_STEP_PCT_BY_WINDOW[candidate?.payload?.surgeWindow],
    postAlertGrowthPct: SURGE_POST_ALERT_REPEAT_GROWTH_PCT,
  });
}

function isSameSessionMeteoraPrimedState(candidate, state, profile) {
  if (candidate?.kind !== 'meteora-surge' || !state) {
    return false;
  }

  if (toTextOrNull(state?.metadata?.lastDecision) !== 'primed-hot') {
    return false;
  }

  const profileLoadedAt = toProfileLoadedAtIso(profile);
  const stateSessionStartedAt = toTextOrNull(state?.metadata?.sessionStartedAt);
  return Boolean(profileLoadedAt && stateSessionStartedAt && profileLoadedAt === stateSessionStartedAt);
}

function canRepeatMeteoraInSession(candidate, state, profile) {
  if (candidate?.kind !== 'meteora-surge' || !state) {
    return false;
  }

  const lastAlertedPct = toNumberOrNull(state?.lastAlertedPct);
  const nextPct = toNumberOrNull(candidate?.pct);
  if (lastAlertedPct == null || nextPct == null) {
    return false;
  }

  const sameSessionPrimedHot = isSameSessionMeteoraPrimedState(candidate, state, profile)
    && toTimestampMs(state?.lastAlertedAt) == null;
  const requiredAdvancePct = sameSessionPrimedHot
    ? METEORA_PRIMED_ACTIVITY_PROOF_STEP_PCT
    : METEORA_POST_ALERT_REPEAT_STEP_PCT;

  if (nextPct < lastAlertedPct + requiredAdvancePct) {
    return false;
  }

  if (sameSessionPrimedHot) {
    return true;
  }

  const lastAlertedTvl = toNumberOrNull(state?.lastAlertedValue);
  const nextTvl = toNumberOrNull(candidate?.lastAlertedValue);
  if (!(lastAlertedTvl > 0) || !(nextTvl > 0)) {
    return false;
  }

  const requiredNextTvl = lastAlertedTvl * (1 + (METEORA_REPEAT_TVL_GROWTH_PCT / 100));
  return nextTvl >= requiredNextTvl;
}

function getAnchoredRepeatPct(candidate, state) {
  const nextAlertedValue = toNumberOrNull(candidate?.lastAlertedValue);
  const lastAlertedValue = toNumberOrNull(state?.lastAlertedValue);
  if (nextAlertedValue == null || lastAlertedValue == null || lastAlertedValue <= 0) {
    return toNumberOrNull(candidate?.pct);
  }
  return ((nextAlertedValue - lastAlertedValue) / lastAlertedValue) * 100;
}

function buildRepeatAwarePayload(candidate, state) {
  const payload = {
    ...(candidate?.payload || {}),
  };

  if (!ANCHORED_REPEAT_RULE_KEYS.has(candidate?.ruleKey) || !state) {
    return {
      ...payload,
      pct: candidate?.pct,
      label: candidate?.label,
    };
  }

  const lastAlertedValue = toNumberOrNull(state?.lastAlertedValue);
  if (lastAlertedValue == null) {
    return {
      ...payload,
      pct: candidate?.pct,
      label: candidate?.label,
    };
  }

  if (candidate.ruleKey === 'monitored-vol') {
    payload.prevVolume5m = lastAlertedValue;
  } else if (candidate.ruleKey === GMGN_VOL_1M_RULE_KEY) {
    payload.prevVolume1m = lastAlertedValue;
  } else if (candidate.ruleKey === 'monitored-mcap') {
    payload.prevMcap = lastAlertedValue;
  }

  return {
    ...payload,
    pct: getAnchoredRepeatPct(candidate, state),
    label: candidate?.label,
  };
}

function getRelatedSurgeRuleKeys(ruleKey) {
  return SURGE_RULE_KEYS.includes(ruleKey) ? SURGE_RULE_KEYS : [];
}

function buildSurgeContinuation6hRuleSpecs(profile, signals) {
  const specs = [];
  if (profile?.ruleEnabled?.recentSurge6h
    && (signals.recentSurge6hAgeGatePassed ?? signals.recentSurgeAgeGatePassed)) {
    specs.push({
      baseRuleKey: 'recent-surge-6h',
      ageBucket: 'recent',
      thresholdPct: toNumberOrNull(profile?.recentSurge6hThresholdPct),
    });
  }
  if (profile?.ruleEnabled?.oldWeekSurge6h && signals.oldWeekSurgeAgeGatePassed) {
    specs.push({
      baseRuleKey: 'old-week-surge-6h',
      ageBucket: 'old-week',
      thresholdPct: toNumberOrNull(profile?.oldWeekSurge6hThresholdPct),
    });
  }
  return specs;
}

function getSurgeContinuation6hBaseContext(state, nowMs) {
  const baseMcap = toNumberOrNull(state?.metadata?.lastAlertedMcap);
  const baseEventId = toNumberOrNull(state?.metadata?.lastEventId);
  const baseAlertedAtMs = toTimestampMs(state?.lastAlertedAt);
  if (!(baseMcap > 0) || !(baseEventId > 0) || baseAlertedAtMs == null) {
    return null;
  }
  if ((nowMs - baseAlertedAtMs) < SURGE_CONTINUATION_6H_MIN_BASE_ALERT_AGE_MS) {
    return null;
  }
  if (toNumberOrNull(state?.metadata?.[SURGE_CONTINUATION_6H_BASE_EVENT_METADATA_KEY]) === baseEventId) {
    return null;
  }

  return { baseMcap, baseEventId };
}

function buildSurgeContinuation6hPayload(tokenAfter, signals, state, spec, nowMs) {
  const baseContext = getSurgeContinuation6hBaseContext(state, nowMs);
  const currentMcap = toNumberOrNull(signals?.currentMcap);
  const currentPchange6h = toNumberOrNull(signals?.currentPriceChange6h);
  const thresholdPct = toNumberOrNull(spec?.thresholdPct);
  if (!baseContext || !(currentMcap > 0)
    || currentPchange6h == null || thresholdPct == null || currentPchange6h < thresholdPct) {
    return null;
  }
  if (currentMcap < baseContext.baseMcap * SURGE_CONTINUATION_6H_MCAP_MULTIPLIER) {
    return null;
  }

  return {
    ...buildSharedPayload(tokenAfter, signals),
    prevMcap: baseContext.baseMcap,
    pct: currentPchange6h,
    label: 'SURGE CONTINUATION 6H',
    ageBucket: spec.ageBucket,
    isOldSurge: true,
    surgeWindow: '6H',
    thresholdPct,
    tokenAgeMs: toNumberOrNull(signals.ageMs),
    surgeContinuation: true,
    surgeContinuationBaseEventId: baseContext.baseEventId,
    surgeContinuationBaseRuleKey: spec.baseRuleKey,
    surgeContinuationBaseMcap: baseContext.baseMcap,
    surgeContinuationMultiplier: currentMcap / baseContext.baseMcap,
    surgeContinuationRequiredMultiplier: SURGE_CONTINUATION_6H_MCAP_MULTIPLIER,
  };
}

function buildSurgeContinuation6hDedupeKey(profile, tokenAfter, baseEventId) {
  return `${profile.userId}:${SURGE_CONTINUATION_6H_RULE_KEY}:${tokenAfter.address}:${baseEventId}`;
}

async function emitSurgeContinuation6h(profile, tokenAfter, spec, state, payload, nowMs, deps) {
  const client = await deps.db.getClient();
  let event = null;
  const baseEventId = toNumberOrNull(payload.surgeContinuationBaseEventId);
  try {
    await client.query('BEGIN');

    event = await deps.userAlertEvent.createEvent({
      userId: profile.userId,
      ruleKey: SURGE_CONTINUATION_6H_RULE_KEY,
      kind: 'old-surge',
      chain: ALERT_CHAIN,
      tokenAddress: tokenAfter.address,
      dedupeKey: buildSurgeContinuation6hDedupeKey(profile, tokenAfter, baseEventId),
      payload,
      triggeredAt: new Date(nowMs),
    }, client);

    await deps.userAlertRuleState.markRearmed({
      userId: profile.userId,
      ruleKey: spec.baseRuleKey,
      chain: ALERT_CHAIN,
      tokenAddress: tokenAfter.address,
      cooldownUntil: state.cooldownUntil,
      lastFingerprint: state.lastFingerprint,
      metadata: {
        ...(state?.metadata || {}),
        lastDecision: 'rearmed',
        [SURGE_CONTINUATION_6H_BASE_EVENT_METADATA_KEY]: baseEventId,
        surgeContinuation6hAlertedAt: new Date(nowMs).toISOString(),
        surgeContinuation6hEventId: event?.id || null,
        surgeContinuation6hMcap: toNumberOrNull(payload.mcap),
        surgeContinuation6hMultiplier: toNumberOrNull(payload.surgeContinuationMultiplier),
      },
    }, client);

    await client.query('COMMIT');
    await deps.backendAlertPublisher.publishEventSafe(event, {
      logLabel: 'UserAlertMatcher',
    });
    return event;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
    }
    throw error;
  } finally {
    client.release();
  }
}

async function evaluateSurgeContinuation6h(profile, tokenAfter, signals, nowMs, deps, summary) {
  const currentMcap = toNumberOrNull(signals?.currentMcap);
  if (!(currentMcap >= SURGE_6H_MIN_MCAP)) {
    return;
  }

  for (const spec of buildSurgeContinuation6hRuleSpecs(profile, signals)) {
    const state = await deps.userAlertRuleState.getState(profile.userId, spec.baseRuleKey, tokenAfter.address);
    const payload = buildSurgeContinuation6hPayload(tokenAfter, signals, state, spec, nowMs);
    if (!payload) {
      continue;
    }

    const event = await emitSurgeContinuation6h(profile, tokenAfter, spec, state, payload, nowMs, deps);
    summary.emitted += 1;
    summary.events.push(event);
  }
}

async function hasBlockingRelatedSurgeAlert(profile, tokenAfter, candidate, nowMs, deps) {
  if (candidate?.kind !== 'old-surge') {
    return false;
  }

  const relatedRuleKeys = getRelatedSurgeRuleKeys(candidate.ruleKey);
  for (const relatedRuleKey of relatedRuleKeys) {
    const relatedState = await deps.userAlertRuleState.getState(profile.userId, relatedRuleKey, tokenAfter.address);
    if (isSurgeAnchorExpired({ ruleKey: relatedRuleKey }, relatedState, nowMs)) {
      continue;
    }
    const lastAlertedAtMs = toTimestampMs(relatedState?.lastAlertedAt);
    if (lastAlertedAtMs == null) {
      continue;
    }
    if (isSixHourSurgeCandidate(candidate)
      && isSixHourSurgeRuleKey(relatedRuleKey)
      && isSixHourSurgeCooldownActive({ ruleKey: relatedRuleKey }, relatedState, nowMs)) {
      return true;
    }
    if ((nowMs - lastAlertedAtMs) < SURGE_CROSS_WINDOW_COOLDOWN_MS) {
      return true;
    }
    if (toNumberOrNull(relatedState?.lastAlertedPct) != null
      && !canRepeatSurgeInSession(candidate, relatedState)) {
      return true;
    }
  }

  return false;
}

async function primeCandidate(profile, tokenAfter, candidate, nowMs, deps) {
  return deps.userAlertRuleState.markTriggered({
    userId: profile.userId,
    ruleKey: candidate.ruleKey,
    chain: ALERT_CHAIN,
    tokenAddress: tokenAfter.address,
    lastAlertedAt: null,
    lastAlertedValue: candidate.lastAlertedValue,
    lastAlertedPct: candidate.pct,
    cooldownUntil: null,
    lastFingerprint: candidate.fingerprint,
    metadata: {
      ageBucket: candidate.payload?.ageBucket || null,
      label: candidate.label,
      lastAlertedMcap: toNumberOrNull(candidate.payload?.mcap),
      lastDecision: 'primed-hot',
      primedAt: new Date(nowMs).toISOString(),
      sessionStartedAt: toProfileLoadedAtIso(profile),
      surgeWindow: candidate.payload?.surgeWindow || null,
      thresholdPct: toNumberOrNull(candidate.payload?.thresholdPct),
    },
  });
}

function shouldRearmImmediatelyAfterEmit(candidate) {
  return candidate?.kind === 'old-surge';
}

async function rearmCandidateAfterEmitIfNeeded(profile, tokenAfter, candidate, event, nowMs, deps, runner) {
  if (!shouldRearmImmediatelyAfterEmit(candidate)) {
    return;
  }

  await deps.userAlertRuleState.markRearmed({
    userId: profile.userId,
    ruleKey: candidate.ruleKey,
    chain: ALERT_CHAIN,
    tokenAddress: tokenAfter.address,
    cooldownUntil: candidate.cooldownMs > 0 ? new Date(nowMs + candidate.cooldownMs) : null,
    lastFingerprint: candidate.fingerprint,
    metadata: {
      lastDecision: 'rearmed',
      rearmedAt: new Date(nowMs).toISOString(),
      lastEventId: event?.id || null,
      lastAlertedMcap: toNumberOrNull(candidate.payload?.mcap),
      lastHiddenSessionKey: toProfileHiddenSessionKey(profile),
      lastPresenceMode: toProfilePresenceMode(profile),
      label: candidate.label,
      sessionStartedAt: toProfileLoadedAtIso(profile),
    },
  }, runner);
}

async function emitCandidate(profile, tokenAfter, candidate, state, nowMs, deps) {
  const client = await deps.db.getClient();
  let event = null;
  const tickerPeers = await (deps.alertTickerPeers || alertTickerPeers).buildTickerPeerSnapshotForAlert({
    chain: ALERT_CHAIN,
    address: tokenAfter.address,
    symbol: candidate.payload?.symbol || tokenAfter.symbol || null,
    name: candidate.payload?.name || tokenAfter.name || null,
  }, { snapshotTsMs: nowMs });

  try {
    await client.query('BEGIN');

    const eventPayload = buildRepeatAwarePayload(candidate, state);
    if (tickerPeers) {
      eventPayload.tickerPeers = tickerPeers;
    }

    event = await deps.userAlertEvent.createEvent({
      userId: profile.userId,
      ruleKey: candidate.ruleKey,
      kind: candidate.kind,
      chain: ALERT_CHAIN,
      tokenAddress: tokenAfter.address,
      dedupeKey: buildEventDedupeKey(profile, tokenAfter, candidate),
      payload: eventPayload,
      triggeredAt: new Date(nowMs),
    }, client);

    await deps.userAlertRuleState.markTriggered({
      userId: profile.userId,
      ruleKey: candidate.ruleKey,
      chain: ALERT_CHAIN,
      tokenAddress: tokenAfter.address,
      lastAlertedAt: new Date(nowMs),
      lastAlertedValue: candidate.lastAlertedValue,
      lastAlertedPct: candidate.pct,
      cooldownUntil: candidate.cooldownMs > 0 ? new Date(nowMs + candidate.cooldownMs) : null,
      lastFingerprint: candidate.fingerprint,
      metadata: {
        lastDecision: 'triggered',
        lastEventId: event?.id || null,
        lastAlertedMcap: toNumberOrNull(candidate.payload?.mcap),
        lastHiddenSessionKey: toProfileHiddenSessionKey(profile),
        lastPresenceMode: toProfilePresenceMode(profile),
        label: candidate.label,
        sessionStartedAt: toProfileLoadedAtIso(profile),
      },
    }, client);

    await rearmCandidateAfterEmitIfNeeded(profile, tokenAfter, candidate, event, nowMs, deps, client);

    await client.query('COMMIT');
    await deps.backendAlertPublisher.publishEventSafe(event, {
      logLabel: 'UserAlertMatcher',
    });
    return event;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
    }
    throw error;
  } finally {
    client.release();
  }
}

function buildCustomAlertDedupeKey(rule) {
  return `${rule.userId}:${CUSTOM_ALERT_RULE_KEY}:${rule.id}:triggered`;
}

async function emitCustomAlertRule(rule, tokenBefore, tokenAfter, currentValue, previousValue, nowMs, deps) {
  const client = await deps.db.getClient();
  let event = null;

  try {
    await client.query('BEGIN');

    const triggeredRule = await deps.userCustomAlertRule.markTriggered(rule.id, rule.userId, {
      chain: ALERT_CHAIN,
      triggeredAt: new Date(nowMs),
    }, client);
    if (!triggeredRule) {
      await client.query('ROLLBACK');
      return null;
    }

    event = await deps.userAlertEvent.createEvent({
      userId: rule.userId,
      ruleKey: CUSTOM_ALERT_RULE_KEY,
      kind: CUSTOM_ALERT_RULE_KEY,
      chain: ALERT_CHAIN,
      tokenAddress: tokenAfter.address,
      dedupeKey: buildCustomAlertDedupeKey(rule),
      payload: buildCustomAlertPayload(rule, tokenBefore, tokenAfter, currentValue, previousValue),
      triggeredAt: new Date(nowMs),
    }, client);

    await client.query('COMMIT');
    await deps.backendAlertPublisher.publishEventSafe(event, {
      logLabel: 'UserAlertMatcher',
    });
    return event;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
    }
    throw error;
  } finally {
    client.release();
  }
}

async function evaluateCustomAlertRules(tokenBefore, tokenAfter, nowMs, deps, summary) {
  const identity = { chain: ALERT_CHAIN, address: tokenAfter.address };
  const rules = await deps.userCustomAlertRule.listActiveByTokenIdentity(identity);
  const observation = buildSolanaCustomAlertObservation(tokenAfter, nowMs);
  const previousObservation = buildSolanaCustomAlertObservation(tokenBefore);
  for (const rule of rules) {
    try {
      const evaluation = evaluateCustomAlertRule(rule, observation, previousObservation);
      if (!evaluation.matched) {
        summary.suppressed += 1;
        continue;
      }

      const event = await emitCustomAlertRule(
        rule,
        tokenBefore,
        tokenAfter,
        evaluation.intent.currentValue,
        evaluation.intent.previousValue,
        nowMs,
        deps,
      );
      if (event) {
        summary.emitted += 1;
        summary.events.push(event);
      } else {
        summary.suppressed += 1;
      }
    } catch (error) {
      summary.errors += 1;
      console.error(`[UserAlertMatcher] Failed to evaluate custom alert ${rule?.id || 'unknown'} for token ${tokenAfter.address}:`, error.message);
    }
  }
}

function shouldPreserveCooldownOnRearm(ruleKey) {
  return REARM_PRESERVE_COOLDOWN_RULE_KEYS.has(String(ruleKey || '').trim().toLowerCase());
}

async function rearmRule(profile, tokenAfter, ruleKey, state, nowMs, deps, signals = null) {
  const coldMetadata = ruleKey === 'monitored-vol'
    ? buildMonitoredVolColdMetadata(state, signals, nowMs).metadata
    : null;

  return deps.userAlertRuleState.markRearmed({
    userId: profile.userId,
    ruleKey,
    chain: ALERT_CHAIN,
    tokenAddress: tokenAfter.address,
    cooldownUntil: shouldPreserveCooldownOnRearm(ruleKey) ? state?.cooldownUntil : null,
    metadata: {
      ...(state?.metadata || {}),
      ...(coldMetadata || {}),
      lastDecision: 'rearmed',
      rearmedAt: new Date(nowMs).toISOString(),
    },
  });
}

function resolveCandidateState(candidate, rawState, profile, nowMs) {
  if (isMonitoredVolAnchorExpired(candidate, rawState, nowMs)) {
    return null;
  }
  if (isSurgeAnchorExpired(candidate, rawState, nowMs)) {
    return null;
  }

  if (candidate?.kind === 'old-surge') {
    if (!rawState) {
      return null;
    }

    if (isSameSurgeSessionState(candidate, rawState, profile)) {
      return rawState;
    }

    const lastDecision = toTextOrNull(rawState?.metadata?.lastDecision);
    const wasOnlyPrimed = lastDecision === 'primed-hot'
      && toTimestampMs(rawState?.lastAlertedAt) == null;
    return wasOnlyPrimed ? null : rawState;
  }
  if (candidate?.kind === 'meteora-surge'
    && toTextOrNull(rawState?.metadata?.lastDecision) === 'primed-hot'
    && !isSameSessionMeteoraPrimedState(candidate, rawState, profile)) {
    return null;
  }
  return rawState;
}

function shouldSuppressSurgeRepeat(candidate, state, profile) {
  return candidate?.kind === 'old-surge'
    && (isSameSurgeSessionState(candidate, state, profile) || toTimestampMs(state?.lastAlertedAt) != null)
    && toNumberOrNull(state?.lastAlertedPct) != null
    && !canRepeatSurgeInSession(candidate, state);
}

function shouldSuppressMeteoraSessionRepeat(candidate, state, profile) {
  return candidate?.kind === 'meteora-surge'
    && state?.status === 'triggered'
    && state?.rearmRequired === true
    && toNumberOrNull(state?.lastAlertedPct) != null
    && !canRepeatMeteoraInSession(candidate, state, profile);
}

function shouldSuppressHiddenSessionRepeat(state, profile) {
  if (toProfilePresenceMode(profile) !== 'hidden') {
    return false;
  }

  return toTimestampMs(state?.lastAlertedAt) != null
    && toTextOrNull(state?.metadata?.lastPresenceMode) === 'hidden';
}

function buildEventDedupeKey(profile, tokenAfter, candidate) {
  if (toProfilePresenceMode(profile) === 'hidden') {
    return `${profile.userId}:${candidate.ruleKey}:${tokenAfter.address}:hidden`;
  }

  if (candidate?.ruleKey === 'hvnc') {
    return `${profile.userId}:${candidate.ruleKey}:${tokenAfter.address}`;
  }

  return `${profile.userId}:${candidate.ruleKey}:${tokenAfter.address}:${candidate.fingerprint}`;
}

function resolveRepeatAllowed(candidate, state, profile) {
  if (candidate?.kind === 'old-surge') {
    return canRepeatSurgeInSession(candidate, state);
  }
  if (candidate?.kind === 'meteora-surge') {
    return canRepeatMeteoraInSession(candidate, state, profile);
  }
  return canRepeatCandidate(candidate, state);
}

function hasSatisfiedRepeatAdvance(candidate, state, profile, repeatAllowed) {
  if (candidate?.kind === 'meteora-surge'
    && isSameSessionMeteoraPrimedState(candidate, state, profile)) {
    return repeatAllowed;
  }
  return hasAdvancedRepeatValue(candidate, state);
}

function getCandidateLifecycleDecision(candidate, state, profile, nowMs) {
  const triggered = state?.status === 'triggered' && state?.rearmRequired === true;
  const cooldownActive = isCooldownActive(state, nowMs);
  const sixHourSurgeCooldownActive = isSixHourSurgeCooldownActive(candidate, state, nowMs);
  const repeatAllowed = resolveRepeatAllowed(candidate, state, profile);
  const hasAdvancedRepeat = hasSatisfiedRepeatAdvance(candidate, state, profile, repeatAllowed);

  if (shouldPrimeCandidate(candidate, state, nowMs)) {
    return 'prime';
  }
  if (shouldSuppressHiddenSessionRepeat(state, profile)) {
    return 'suppress';
  }
  if (shouldSuppressSurgeRepeat(candidate, state, profile)) {
    return 'suppress';
  }
  if (shouldSuppressMeteoraSessionRepeat(candidate, state, profile)) {
    return 'suppress';
  }
  if (!hasAdvancedRepeat) {
    return 'suppress';
  }
  if (triggered && (cooldownActive || sixHourSurgeCooldownActive || !repeatAllowed)) {
    return 'suppress';
  }
  return cooldownActive || sixHourSurgeCooldownActive ? 'suppress' : 'emit';
}

async function handleRuleLifecycle(profile, tokenAfter, candidates, rearmRuleKeys, nowMs, deps, summary) {
  for (const candidate of Array.isArray(candidates) ? candidates : [candidates].filter(Boolean)) {
    const rawState = await deps.userAlertRuleState.getState(profile.userId, candidate.ruleKey, tokenAfter.address);
    const highSyncedState = await syncTriggeredSurgePostAlertHighState(
      profile,
      tokenAfter,
      candidate.ruleKey,
      rawState,
      candidate.payload,
      deps,
    );
    const syncedState = await syncRearmedResetState(
      profile,
      tokenAfter,
      candidate.ruleKey,
      highSyncedState,
      candidate.payload,
      nowMs,
      deps,
      {
        preserveExpiredColdAnchor: true,
        preserveExpiredSurgeAnchor: true,
      },
    );
    const state = resolveCandidateState(candidate, syncedState, profile, nowMs);
    const hasBlockingSurgeAlert = await hasBlockingRelatedSurgeAlert(profile, tokenAfter, candidate, nowMs, deps);
    const decision = getCandidateLifecycleDecision(candidate, state, profile, nowMs);

    if (decision === 'prime') {
      await primeCandidate(profile, tokenAfter, candidate, nowMs, deps);
      summary.suppressed += 1;
    } else if (hasBlockingSurgeAlert) {
      summary.suppressed += 1;
    } else if (decision === 'emit') {
      const event = await emitCandidate(profile, tokenAfter, candidate, state, nowMs, deps);
      summary.emitted += 1;
      summary.events.push(event);
    } else {
      summary.suppressed += 1;
    }
  }

  for (const ruleKey of rearmRuleKeys) {
    const state = await deps.userAlertRuleState.getState(profile.userId, ruleKey, tokenAfter.address);
    if (isResettableSurgeRuleKey(ruleKey)) {
      await syncRearmedResetState(profile, tokenAfter, ruleKey, state, tokenAfter, nowMs, deps);
    } else if (state?.status === 'triggered' && state?.rearmRequired === true) {
      await rearmRule(profile, tokenAfter, ruleKey, state, nowMs, deps, tokenAfter);
      summary.rearmed += 1;
    } else {
      await syncRearmedResetState(profile, tokenAfter, ruleKey, state, tokenAfter, nowMs, deps);
    }
  }
}

async function loadSignals(tokenBefore, tokenAfter, profiles, nowMs, deps, context = {}) {
  const address = String(tokenAfter?.address || '').trim();
  const [volumeRows, mcapRows, surgeRows, meteoraRows] = await Promise.all([
    loadVolumeRows(address, profiles, deps, context),
    loadMcapRows(address, profiles, deps),
    loadSurgeRows(address, profiles, deps),
    loadMeteoraRows(address, profiles, deps),
  ]);

  const volumeRow = volumeRows[0] || null;
  const mcapRow = mcapRows[0] || null;
  const surgeRow = surgeRows[0] || null;
  const meteoraRow = meteoraRows[0] || null;

  return deps.tokenAlertSignalBuilder.buildTokenAlertSignals(
    buildSignalInput(tokenBefore, tokenAfter, volumeRow, mcapRow, surgeRow, meteoraRow, context),
    { nowMs }
  );
}

function isSupportedAlertToken(token) {
  if (!token?.address) return false;
  try {
    return normalizeTokenChain(token.chain || ALERT_CHAIN) === ALERT_CHAIN;
  } catch (_) {
    return false;
  }
}

async function evaluateUpdatedToken(input = {}, options = {}) {
  const deps = {
    db,
    tokenMarketBucket1m,
    tokenMarketVolumeBucket1m,
    tokenMeteoraState,
    userAlertEvent,
    userAlertRuleState,
    userCustomAlertRule,
    backendAlertPublisher,
    tokenAlertSignalBuilder,
    userAlertProfileCache,
    ...(options.deps || {}),
  };
  deps.tokenAlertSignalBuilder = deps.tokenAlertSignalBuilder || tokenAlertSignalBuilder;
  const summary = createEmptySummary();
  const tokenAfter = input.tokenAfter || null;
  const tokenBefore = input.tokenBefore || null;
  const nowMs = toTimestampMs(options.now) ?? Date.now();
  const alertSource = toTextOrNull(options.alertSource || input.alertSource);

  if (!isSupportedAlertToken(tokenAfter)) {
    return summary;
  }

  try {
    await evaluateCustomAlertRules(tokenBefore, tokenAfter, nowMs, deps, summary);
  } catch (error) {
    summary.errors += 1;
    console.error(`[UserAlertMatcher] Failed to evaluate custom alert rules for token ${tokenAfter.address}:`, error.message);
  }

  const profiles = await deps.userAlertProfileCache.listActiveProfiles({ nowMs });
  summary.evaluatedProfiles = profiles.length;
  if (!profiles.length) {
    return summary;
  }

  const signals = await loadSignals(tokenBefore, tokenAfter, profiles, nowMs, deps, { alertSource });

  for (const profile of profiles) {
    try {
      const ruleDecision = buildRuleCandidate(profile, tokenAfter, signals);
      const rearmRuleKeys = buildRearmRuleKeys(profile, ruleDecision.qualifiedRuleKeys);
      await handleRuleLifecycle(profile, tokenAfter, ruleDecision.candidates, rearmRuleKeys, nowMs, deps, summary);
      await evaluateSurgeContinuation6h(profile, tokenAfter, signals, nowMs, deps, summary);
    } catch (error) {
      summary.errors += 1;
      console.error(`[UserAlertMatcher] Failed to evaluate token ${tokenAfter.address} for user ${profile?.userId || 'unknown'}:`, error.message);
    }
  }

  return summary;
}

module.exports = {
  MATCHER_RULE_KEYS,
  STANDARD_ALERT_COOLDOWN_MS,
  SURGE_CROSS_WINDOW_COOLDOWN_MS,
  SURGE_1H_MIN_MCAP,
  SURGE_6H_MIN_MCAP,
  SURGE_STARTUP_SUPPRESS_MS,
  SURGE_POST_ALERT_REPEAT_GROWTH_PCT,
  SURGE_CONTINUATION_6H_RULE_KEY,
  SURGE_CONTINUATION_6H_MCAP_MULTIPLIER,
  SURGE_PRIMED_ACTIVITY_PROOF_STEP_PCT_BY_WINDOW,
  METEORA_ALERT_COOLDOWN_MS,
  METEORA_STARTUP_SUPPRESS_MS,
  METEORA_PRIMED_ACTIVITY_PROOF_STEP_PCT,
  METEORA_FINGERPRINT_CHANGE_BUCKET_PCT,
  METEORA_FINGERPRINT_TVL_BUCKET_USD,
  MONITORED_VOL_COLD_RESET_DURATION_MS,
  MONITORED_VOL_COLD_HOT_BLIP_GRACE_MS,
  MONITORED_VOL_COLD_RESET_MAX_VOLUME_5M,
  SURGE_6H_RESET_MAX_PCHANGE_PCT,
  SURGE_6H_RESET_PCHANGE_DURATION_MS,
  SURGE_6H_RESET_DRAWDOWN_RATIO,
  SURGE_6H_RESET_DRAWDOWN_DURATION_MS,
  SURGE_1H_RESET_PCHANGE_THRESHOLD_RATIO,
  SURGE_1H_RESET_PCHANGE_DURATION_MS,
  SURGE_1H_RESET_DRAWDOWN_RATIO,
  SURGE_1H_RESET_DRAWDOWN_DURATION_MS,
  GMGN_VOL_1M_RULE_KEY,
  GMGN_VOL_1M_ALERT_THRESHOLD_PCT,
  GMGN_VOL_1M_ALERT_COOLDOWN_MS,
  GMGN_VOL_1M_REPEAT_STEP_PCT,
  evaluateUpdatedToken,
  __private: {
    bucketMetric,
    buildFingerprint,
    buildHvncCandidate,
    buildMeteoraCandidate,
    buildGmgnVol1mCandidate,
    buildMonitoredMcapCandidate,
    buildMonitoredVolCandidate,
    buildSurgeCandidate,
    buildSurgeCandidates,
    buildRuleCandidate,
    buildLifecycleCandidates,
    buildSignalInput,
    buildRepeatAwarePayload,
    buildVolumeSignalInput,
    buildMcapSignalInput,
    buildPriceChangeSignalInput,
    buildSharedPayload,
    buildRearmRuleKeys,
    canRepeatMeteoraInSession,
    canRepeatCandidate,
    canRepeatSurgeInSession,
    buildEventDedupeKey,
    getAnchoredRepeatPct,
    hasRequiredSurgePctAdvance,
    hasSatisfiedRepeatAdvance,
    hasAdvancedRepeatValue,
    isMonitoredVolAnchorExpired,
    hasBlockingRelatedSurgeAlert,
    createEmptySummary,
    getCandidateLifecycleDecision,
    getRelatedSurgeRuleKeys,
    isSurgeAnchorExpired,
    buildSurgeResetMetadata,
    buildSurgePostAlertHighMetadata,
    isSameSessionMeteoraPrimedState,
    isSameSurgeSessionState,
    isCooldownActive,
    loadMcapRows,
    loadSignals,
    loadMeteoraRows,
    loadVolumeRows,
    mergeVolumeRows,
    needsGmgnVolume1mBaseline,
    needsMcapBaseline,
    needsMeteoraState,
    needsVolumeBaseline,
    passesCommonAlertFilters,
    primeCandidate,
    roundAlertMetric,
    resolveCandidateState,
    resolveDisplaySymbol,
    shouldSuppressSurgeRepeat,
    shouldSuppressHiddenSessionRepeat,
    toProfileHiddenSessionKey,
    toProfileLoadedAtMs,
    toProfileLoadedAtIso,
    toProfilePresenceMode,
    shouldPreserveCooldownOnRearm,
    shouldPrimeCandidate,
    resolveRepeatAllowed,
    toNumberOrNull,
    toTextOrNull,
    toTimestampMs,
  },
};
