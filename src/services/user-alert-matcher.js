const db = require('../models/db');
const tokenMarketBucket1m = require('../models/token-market-bucket-1m');
const tokenMarketVolumeBucket1m = require('../models/token-market-volume-bucket-1m');
const tokenMeteoraState = require('../models/token-meteora-state');
const userAlertEvent = require('../models/user-alert-event');
const userAlertRuleState = require('../models/user-alert-rule-state');
const backendAlertPublisher = require('./backend-alert-publisher');
const alertTickerPeers = require('./alert-ticker-peers');
const tokenAlertSignalBuilder = require('./token-alert-signal-builder');
const userAlertProfileCache = require('./user-alert-profile-cache');

const STANDARD_ALERT_COOLDOWN_MS = 60 * 1000;
const SURGE_CROSS_WINDOW_COOLDOWN_MS = 60 * 60 * 1000;
const SURGE_1H_MIN_MCAP = 60_000;
const SURGE_6H_MIN_MCAP = 60_000;
const SURGE_STARTUP_SUPPRESS_MS = 60 * 1000;
const SURGE_POST_ALERT_REPEAT_GROWTH_PCT = 50;
const SURGE_6H_REPEAT_COOLDOWN_MS = 20 * 60 * 1000;
const SURGE_6H_REPEAT_MCAP_GROWTH_PCT = 15;
const SURGE_PRIMED_ACTIVITY_PROOF_STEP_PCT_BY_WINDOW = Object.freeze({
  '1H': 5,
  '6H': 10,
});
const METEORA_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const METEORA_STARTUP_SUPPRESS_MS = 60 * 1000;
const METEORA_PRIMED_ACTIVITY_PROOF_STEP_PCT = 10;
const METEORA_POST_ALERT_REPEAT_STEP_PCT = 50;
const METEORA_REPEAT_TVL_GROWTH_PCT = 15;
const METEORA_FINGERPRINT_CHANGE_BUCKET_PCT = 5;
const METEORA_FINGERPRINT_TVL_BUCKET_USD = 10_000;
const GMGN_VOL_1M_RULE_KEY = 'gmgn-vol-1m';
const GMGN_VOL_1M_ALERT_THRESHOLD_PCT = 50;
const GMGN_VOL_1M_ALERT_COOLDOWN_MS = 60 * 1000;
const GMGN_VOL_1M_REPEAT_STEP_PCT = 50;
const GMGN_VOL_1M_ALERT_ENABLED = false;
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
  return {
    address,
    symbol: resolveDisplaySymbol(tokenAfter, address),
    name: toTextOrNull(tokenAfter?.name),
    pairAddress: toTextOrNull(tokenAfter?.last_pair_address),
    pairUrl: toTextOrNull(tokenAfter?.last_pair_url),
    imageUrl: toTextOrNull(tokenAfter?.last_image_url),
    twitterUrl: toTextOrNull(tokenAfter?.last_twitter_url),
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
  const currentPct = surgeWindow === '6H'
    ? toNumberOrNull(signals.currentPriceChange6h)
    : toNumberOrNull(signals.currentPriceChange1h);
  const previousPct = surgeWindow === '6H'
    ? toNumberOrNull(signals.prevPriceChange6h)
    : toNumberOrNull(signals.prevPriceChange1h);
  const normalizedThresholdPct = toNumberOrNull(thresholdPct) ?? null;
  const ageGatePassed = ageBucket === 'recent'
    ? signals.recentSurgeAgeGatePassed
    : signals.oldWeekSurgeAgeGatePassed;
  const minMcap = surgeWindow === '6H' ? SURGE_6H_MIN_MCAP : SURGE_1H_MIN_MCAP;
  const qualifies = Boolean(enabled)
    && ageGatePassed
    && currentPct != null
    && normalizedThresholdPct != null
    && (toNumberOrNull(signals.currentMcap) || 0) >= minMcap
    && currentPct >= normalizedThresholdPct;
  if (!qualifies) {
    return null;
  }

  const crossedThreshold = previousPct != null
    && normalizedThresholdPct != null
    && previousPct < normalizedThresholdPct
    && currentPct >= normalizedThresholdPct;

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
    primeOnFirstSeen: !crossedThreshold,
    startupSuppressUntilMs: (() => {
      const loadedAtMs = toProfileLoadedAtMs(profile);
      return loadedAtMs != null ? loadedAtMs + SURGE_STARTUP_SUPPRESS_MS : null;
    })(),
    payload: {
      ...shared,
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
  if (signals.recentSurgeAgeGatePassed) {
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

function buildMcapSignalInput(tokenBefore, tokenAfter, mcapRow) {
  return {
    last_mcap: mcapRow?.current_mcap ?? tokenAfter?.last_mcap,
    baseline_mcap: mcapRow?.baseline_mcap ?? tokenBefore?.last_mcap ?? null,
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

function buildCoreSignalInput(tokenBefore, tokenAfter, volumeRow, mcapRow, context = {}) {
  return {
    tokenAddress: String(tokenAfter?.address || '').trim(),
    alertSource: toTextOrNull(context.alertSource),
    ...buildMigrationSignalInput(tokenAfter),
    ...buildVolumeSignalInput(tokenBefore, tokenAfter, volumeRow),
    ...buildMcapSignalInput(tokenBefore, tokenAfter, mcapRow),
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

function buildSignalInput(tokenBefore, tokenAfter, volumeRow, mcapRow, meteoraRow, context = {}) {
  return {
    ...buildCoreSignalInput(tokenBefore, tokenAfter, volumeRow, mcapRow, context),
    ...buildMeteoraSignalInput(meteoraRow),
  };
}

function isCooldownActive(state, nowMs) {
  const cooldownUntilMs = toTimestampMs(state?.cooldownUntil);
  return cooldownUntilMs != null && cooldownUntilMs > nowMs;
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
  const repeatStepPct = toNumberOrNull(candidate?.repeatStepPct);
  if (!(repeatStepPct > 0)) {
    return true;
  }

  const lastAlertedValue = toNumberOrNull(state?.lastAlertedValue);
  const nextAlertedValue = toNumberOrNull(candidate?.lastAlertedValue);
  if (lastAlertedValue == null || nextAlertedValue == null) {
    return true;
  }

  const requiredNextValue = lastAlertedValue * (1 + (repeatStepPct / 100));
  return nextAlertedValue >= requiredNextValue;
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

function getRequiredSurgeRepeatAdvancePct(candidate, state) {
  const sameSessionPrimedHot = toTextOrNull(state?.metadata?.lastDecision) === 'primed-hot'
    && toTimestampMs(state?.lastAlertedAt) == null;
  const primedProofStepPct = toNumberOrNull(
    SURGE_PRIMED_ACTIVITY_PROOF_STEP_PCT_BY_WINDOW[candidate?.payload?.surgeWindow]
  );

  return {
    sameSessionPrimedHot,
    requiredAdvancePct: sameSessionPrimedHot && primedProofStepPct != null
      ? primedProofStepPct
      : SURGE_POST_ALERT_REPEAT_GROWTH_PCT,
  };
}

function hasRequiredSurgePctAdvance(candidate, state) {
  const lastAlertedPct = toNumberOrNull(state?.lastAlertedPct);
  const nextPct = toNumberOrNull(candidate?.pct);
  if (lastAlertedPct == null || nextPct == null) {
    return false;
  }

  const { sameSessionPrimedHot, requiredAdvancePct } = getRequiredSurgeRepeatAdvancePct(candidate, state);
  const requiredNextPct = sameSessionPrimedHot
    ? lastAlertedPct + requiredAdvancePct
    : lastAlertedPct * (1 + (requiredAdvancePct / 100));

  return nextPct >= requiredNextPct;
}

function hasRequiredSixHourSurgeMcapAdvance(candidate, state) {
  const lastAlertedMcap = toNumberOrNull(state?.metadata?.lastAlertedMcap);
  const nextMcap = toNumberOrNull(candidate?.payload?.mcap);
  if (!(lastAlertedMcap > 0) || !(nextMcap > 0)) {
    return false;
  }

  const requiredNextMcap = lastAlertedMcap * (1 + (SURGE_6H_REPEAT_MCAP_GROWTH_PCT / 100));
  return nextMcap >= requiredNextMcap;
}

function canRepeatSurgeInSession(candidate, state) {
  if (candidate?.kind !== 'old-surge') {
    return true;
  }

  const { sameSessionPrimedHot } = getRequiredSurgeRepeatAdvancePct(candidate, state);
  if (!hasRequiredSurgePctAdvance(candidate, state)) {
    return false;
  }

  if (sameSessionPrimedHot || candidate?.payload?.surgeWindow !== '6H') {
    return true;
  }

  return hasRequiredSixHourSurgeMcapAdvance(candidate, state);
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
  if (ruleKey === 'recent-surge-1h' || ruleKey === 'recent-surge-6h') {
    return ['recent-surge-1h', 'recent-surge-6h'];
  }
  if (ruleKey === 'old-week-surge-1h' || ruleKey === 'old-week-surge-6h') {
    return ['old-week-surge-1h', 'old-week-surge-6h'];
  }
  return [];
}

async function hasRecentRelatedSurgeAlert(profile, tokenAfter, candidate, nowMs, deps) {
  if (candidate?.kind !== 'old-surge') {
    return false;
  }

  const relatedRuleKeys = getRelatedSurgeRuleKeys(candidate.ruleKey);
  for (const relatedRuleKey of relatedRuleKeys) {
    const relatedState = await deps.userAlertRuleState.getState(profile.userId, relatedRuleKey, tokenAfter.address);
    const lastAlertedAtMs = toTimestampMs(relatedState?.lastAlertedAt);
    if (lastAlertedAtMs != null && (nowMs - lastAlertedAtMs) < SURGE_CROSS_WINDOW_COOLDOWN_MS) {
      return true;
    }
  }

  return false;
}

async function primeCandidate(profile, tokenAfter, candidate, nowMs, deps) {
  return deps.userAlertRuleState.markTriggered({
    userId: profile.userId,
    ruleKey: candidate.ruleKey,
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

async function emitCandidate(profile, tokenAfter, candidate, state, nowMs, deps) {
  const client = await deps.db.getClient();
  let event = null;
  const tickerPeers = await (deps.alertTickerPeers || alertTickerPeers).buildTickerPeerSnapshotForAlert({
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
      tokenAddress: tokenAfter.address,
      dedupeKey: buildEventDedupeKey(profile, tokenAfter, candidate),
      payload: eventPayload,
      triggeredAt: new Date(nowMs),
    }, client);

    await deps.userAlertRuleState.markTriggered({
      userId: profile.userId,
      ruleKey: candidate.ruleKey,
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

function shouldPreserveCooldownOnRearm(ruleKey) {
  return REARM_PRESERVE_COOLDOWN_RULE_KEYS.has(String(ruleKey || '').trim().toLowerCase());
}

async function rearmRule(profile, tokenAfter, ruleKey, state, nowMs, deps) {
  return deps.userAlertRuleState.markRearmed({
    userId: profile.userId,
    ruleKey,
    tokenAddress: tokenAfter.address,
    cooldownUntil: shouldPreserveCooldownOnRearm(ruleKey) ? state?.cooldownUntil : null,
    metadata: {
      ...(state?.metadata || {}),
      lastDecision: 'rearmed',
      rearmedAt: new Date(nowMs).toISOString(),
    },
  });
}

function resolveCandidateState(candidate, rawState, profile) {
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

function shouldSuppressSurgeSessionRepeat(candidate, state, profile) {
  return isSameSurgeSessionState(candidate, state, profile)
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
  const repeatAllowed = resolveRepeatAllowed(candidate, state, profile);
  const hasAdvancedRepeat = hasSatisfiedRepeatAdvance(candidate, state, profile, repeatAllowed);

  if (shouldPrimeCandidate(candidate, state, nowMs)) {
    return 'prime';
  }
  if (shouldSuppressHiddenSessionRepeat(state, profile)) {
    return 'suppress';
  }
  if (shouldSuppressSurgeSessionRepeat(candidate, state, profile)) {
    return 'suppress';
  }
  if (shouldSuppressMeteoraSessionRepeat(candidate, state, profile)) {
    return 'suppress';
  }
  if (!hasAdvancedRepeat) {
    return 'suppress';
  }
  if (triggered && (cooldownActive || !repeatAllowed)) {
    return 'suppress';
  }
  return cooldownActive ? 'suppress' : 'emit';
}

async function handleRuleLifecycle(profile, tokenAfter, candidates, rearmRuleKeys, nowMs, deps, summary) {
  for (const candidate of Array.isArray(candidates) ? candidates : [candidates].filter(Boolean)) {
    const rawState = await deps.userAlertRuleState.getState(profile.userId, candidate.ruleKey, tokenAfter.address);
    const state = resolveCandidateState(candidate, rawState, profile);
    const hasRelatedSurgeCooldown = await hasRecentRelatedSurgeAlert(profile, tokenAfter, candidate, nowMs, deps);
    const decision = getCandidateLifecycleDecision(candidate, state, profile, nowMs);

    if (decision === 'prime') {
      await primeCandidate(profile, tokenAfter, candidate, nowMs, deps);
      summary.suppressed += 1;
    } else if (hasRelatedSurgeCooldown) {
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
    if (state?.status === 'triggered' && state?.rearmRequired === true) {
      await rearmRule(profile, tokenAfter, ruleKey, state, nowMs, deps);
      summary.rearmed += 1;
    }
  }
}

async function loadSignals(tokenBefore, tokenAfter, profiles, nowMs, deps, context = {}) {
  const address = String(tokenAfter?.address || '').trim();
  const [volumeRows, mcapRows, meteoraRows] = await Promise.all([
    loadVolumeRows(address, profiles, deps, context),
    loadMcapRows(address, profiles, deps),
    loadMeteoraRows(address, profiles, deps),
  ]);

  const volumeRow = volumeRows[0] || null;
  const mcapRow = mcapRows[0] || null;
  const meteoraRow = meteoraRows[0] || null;

  return deps.tokenAlertSignalBuilder.buildTokenAlertSignals(
    buildSignalInput(tokenBefore, tokenAfter, volumeRow, mcapRow, meteoraRow, context),
    { nowMs }
  );
}

async function evaluateUpdatedToken(input = {}, options = {}) {
  const deps = {
    db,
    tokenMarketBucket1m,
    tokenMarketVolumeBucket1m,
    tokenMeteoraState,
    userAlertEvent,
    userAlertRuleState,
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

  if (!tokenAfter?.address) {
    return summary;
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
  SURGE_PRIMED_ACTIVITY_PROOF_STEP_PCT_BY_WINDOW,
  METEORA_ALERT_COOLDOWN_MS,
  METEORA_STARTUP_SUPPRESS_MS,
  METEORA_PRIMED_ACTIVITY_PROOF_STEP_PCT,
  METEORA_FINGERPRINT_CHANGE_BUCKET_PCT,
  METEORA_FINGERPRINT_TVL_BUCKET_USD,
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
    hasRecentRelatedSurgeAlert,
    createEmptySummary,
    getCandidateLifecycleDecision,
    getRelatedSurgeRuleKeys,
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
    shouldSuppressSurgeSessionRepeat,
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
