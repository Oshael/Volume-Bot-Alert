const HVNC_MAX_AGE_MS = 5 * 60 * 1000;
// Keep this aligned with token-catalog's persisted PumpFun migration grace window.
const PUMPFUN_MIGRATION_GRACE_MS = 10 * 60 * 1000;
const MCAP_ALERT_MIN_TOKEN_AGE_MS = 60 * 60 * 1000;
const METEORA_ALERT_MIN_TVL = 10000;
const SURGE_MIN_AGE_MS = 2 * 24 * 60 * 60 * 1000;
const OLD_WEEK_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function toNumberOrNull(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return null;
  }

  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  return fallback;
}

function firstNumber(...values) {
  for (const value of values) {
    const num = toNumberOrNull(value);
    if (num != null) {
      return num;
    }
  }

  return null;
}

function firstText(...values) {
  for (const value of values) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text) {
      return text;
    }
  }

  return null;
}

function computePctChange(currentValue, baselineValue) {
  const current = toNumberOrNull(currentValue);
  const baseline = toNumberOrNull(baselineValue);
  if (!(current > 0) || !(baseline > 0)) {
    return null;
  }

  const pct = ((current - baseline) / baseline) * 100;
  return Math.abs(pct) < 0.01 ? null : pct;
}

function computeAgeMs(tokenCreatedAt, nowMs) {
  const createdAt = toNumberOrNull(tokenCreatedAt);
  if (!(createdAt > 0)) {
    return null;
  }

  const ageMs = nowMs - createdAt;
  return ageMs >= 0 ? ageMs : null;
}

function toTimestampMs(value) {
  if (!value) return null;
  const numeric = toNumberOrNull(value);
  if (numeric != null) {
    return numeric;
  }

  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
}

function computeMigrationAgeMs(input, nowMs) {
  const source = String(input?.source || '').trim().toLowerCase();
  if (source !== 'pumpfun-migrated') {
    return null;
  }

  const explicitMigratedAt = firstNumber(
    input.migratedAt,
    input.migrationAt,
    input.migrated_at_ms,
    input.migration_at_ms,
  );
  const migrationGraceUntilMs = toTimestampMs(input.migrationGraceUntil ?? input.migration_grace_until);
  const firstSeenAtMs = toTimestampMs(input.firstSeenAt ?? input.first_seen_at);
  const migratedAtMs = explicitMigratedAt
    ?? (migrationGraceUntilMs != null ? migrationGraceUntilMs - PUMPFUN_MIGRATION_GRACE_MS : null)
    ?? firstSeenAtMs;

  if (!(migratedAtMs > 0)) {
    return null;
  }

  const ageMs = nowMs - migratedAtMs;
  return ageMs >= 0 ? ageMs : null;
}

function deriveMeteoraBaselineTvl(currentTvl, changePct) {
  const current = toNumberOrNull(currentTvl);
  const pct = toNumberOrNull(changePct);
  if (!(current > 0) || pct == null) {
    return null;
  }

  const ratio = 1 + (pct / 100);
  if (!(ratio > 0)) {
    return null;
  }

  return current / ratio;
}

function derivePctChangeFromBaseline(currentValue, baselineValue) {
  const current = toNumberOrNull(currentValue);
  const baseline = toNumberOrNull(baselineValue);
  if (!(current > 0) || !(baseline > 0)) {
    return null;
  }

  return computePctChange(current, baseline);
}

function hasMeteoraState(input, meteora) {
  return Boolean(meteora)
    || input.meteoraCurrentTvl != null
    || input.currentMeteoraTvl != null
    || input.meteoraBaselineTvl1h != null
    || input.meteoraBaselineTvl24h != null
    || input.meteoraChange1h != null
    || input.meteoraChange24h != null
    || input.meteoraNoPool != null;
}

function readMeteoraCurrentTvl(input, meteora) {
  return firstNumber(
    input.meteoraCurrentTvl,
    input.currentMeteoraTvl,
    meteora?.tvl,
    meteora?.currentTvl,
  );
}

function readMeteoraChange1h(input, meteora) {
  return firstNumber(
    input.meteoraChange1h,
    meteora?.change1h,
    derivePctChangeFromBaseline(
      input.meteoraCurrentTvl ?? input.currentMeteoraTvl ?? meteora?.tvl ?? meteora?.currentTvl,
      input.meteoraBaselineTvl1h ?? meteora?.baselineTvl1h,
    ),
  );
}

function readMeteoraChange24h(input, meteora) {
  return firstNumber(
    input.meteoraChange24h,
    meteora?.change24h,
    derivePctChangeFromBaseline(
      input.meteoraCurrentTvl ?? input.currentMeteoraTvl ?? meteora?.tvl ?? meteora?.currentTvl,
      input.meteoraBaselineTvl24h ?? meteora?.baselineTvl24h,
    ),
  );
}

function readMeteoraBaselineTvl1h(input, meteora, currentTvl, change1h) {
  return firstNumber(
    input.meteoraBaselineTvl1h,
    meteora?.baselineTvl1h,
    deriveMeteoraBaselineTvl(currentTvl, change1h),
  );
}

function readMeteoraBaselineTvl24h(input, meteora, currentTvl, change24h) {
  return firstNumber(
    input.meteoraBaselineTvl24h,
    meteora?.baselineTvl24h,
    deriveMeteoraBaselineTvl(currentTvl, change24h),
  );
}

function normalizeMeteora(input = {}) {
  const meteora = input?.meteora && typeof input.meteora === 'object' && !Array.isArray(input.meteora)
    ? input.meteora
    : null;
  const hasState = hasMeteoraState(input, meteora);
  const currentTvl = readMeteoraCurrentTvl(input, meteora);
  const change1h = readMeteoraChange1h(input, meteora);
  const change24h = readMeteoraChange24h(input, meteora);
  const baselineTvl1h = readMeteoraBaselineTvl1h(input, meteora, currentTvl, change1h);
  const baselineTvl24h = readMeteoraBaselineTvl24h(input, meteora, currentTvl, change24h);
  const noPool = toBoolean(
    input.meteoraNoPool,
    toBoolean(meteora?.noPool, false),
  );

  return {
    hasState,
    currentTvl,
    baselineTvl1h,
    baselineTvl24h,
    change1h,
    change24h,
    noPool,
  };
}

function normalizeCoreFacts(input = {}, nowMs = Date.now()) {
  return {
    address: firstText(input.address, input.tokenAddress),
    source: firstText(input.source),
    alertSource: firstText(input.alertSource),
    currentVolume5m: firstNumber(
      input.currentVolume5m,
      input.volume5m,
      input.last_vol_5m,
    ),
    currentVolume1m: firstNumber(
      input.currentVolume1m,
      input.volume1m,
      input.last_vol_1m,
      input.current_vol_1m,
    ),
    prevVolume5m: firstNumber(
      input.prevVolume5m,
      input.prevVolume5mCanonical,
      input.baselineVolume5m,
      input.baseline_vol_5m,
    ),
    prevVolume1m: firstNumber(
      input.prevVolume1m,
      input.baselineVolume1m,
      input.baseline_vol_1m,
    ),
    currentMcap: firstNumber(
      input.currentMcap,
      input.mcap,
      input.last_mcap,
      input.current_close_mcap,
    ),
    prevMcap: firstNumber(
      input.prevMcap,
      input.baselineMcap,
      input.baseline_mcap,
    ),
    volume24h: firstNumber(
      input.currentVolume24h,
      input.volume24h,
      input.last_vol_24h,
    ),
    tokenCreatedAt: firstNumber(
      input.tokenCreatedAt,
      input.last_token_created_at_ms,
    ),
    migrationAgeMs: computeMigrationAgeMs(input, nowMs),
    currentPriceChange1h: firstNumber(
      input.currentPriceChange1h,
      input.priceChange1h,
      input.last_price_change_1h,
    ),
    prevPriceChange1h: firstNumber(
      input.prevPriceChange1h,
      input.baselinePriceChange1h,
      input.baseline_price_change_1h,
    ),
    currentPriceChange6h: firstNumber(
      input.currentPriceChange6h,
      input.priceChange6h,
      input.last_price_change_6h,
    ),
    prevPriceChange6h: firstNumber(
      input.prevPriceChange6h,
      input.baselinePriceChange6h,
      input.baseline_price_change_6h,
    ),
  };
}

function isPumpfunMigratedSource(source) {
  return String(source || '').trim().toLowerCase() === 'pumpfun-migrated';
}

function passesHvncAgeGate(facts, ageMs) {
  if (isPumpfunMigratedSource(facts.source)) {
    return facts.migrationAgeMs != null && facts.migrationAgeMs <= HVNC_MAX_AGE_MS;
  }

  return ageMs != null && ageMs <= HVNC_MAX_AGE_MS;
}

function buildSignalFlags(facts, meteora, nowMs) {
  const ageMs = computeAgeMs(facts.tokenCreatedAt, nowMs);
  const vol5mChangePct = computePctChange(facts.currentVolume5m, facts.prevVolume5m);
  const vol1mChangePct = computePctChange(facts.currentVolume1m, facts.prevVolume1m);
  const mcapChangePct = computePctChange(facts.currentMcap, facts.prevMcap);
  const isMcapDeclining = facts.prevMcap != null
    && facts.currentMcap != null
    && facts.prevMcap > 0
    && facts.currentMcap > 0
    && facts.currentMcap < facts.prevMcap;
  const hvncAgeGatePassed = passesHvncAgeGate(facts, ageMs);
  const hvncVolume24hGatePassed = facts.volume24h != null && facts.volume24h > 0;
  const passesHvncPrereqs = hvncAgeGatePassed && hvncVolume24hGatePassed;
  const mcapAlertTokenAgeGatePassed = ageMs == null || ageMs >= MCAP_ALERT_MIN_TOKEN_AGE_MS;
  const recentSurgeAgeGatePassed = ageMs != null
    && ageMs >= SURGE_MIN_AGE_MS
    && ageMs < OLD_WEEK_MIN_AGE_MS;
  const oldWeekSurgeAgeGatePassed = ageMs != null && ageMs >= OLD_WEEK_MIN_AGE_MS;
  const meteoraHasPool = meteora.hasState && !meteora.noPool;
  const meteoraMinTvlGatePassed = meteora.currentTvl != null && meteora.currentTvl >= METEORA_ALERT_MIN_TVL;
  const meteoraBaseline1hGatePassed = meteora.baselineTvl1h != null && meteora.baselineTvl1h >= METEORA_ALERT_MIN_TVL;

  return {
    ageMs,
    migrationAgeMs: facts.migrationAgeMs,
    vol5mChangePct,
    vol1mChangePct,
    mcapChangePct,
    isMcapDeclining,
    hvncAgeGatePassed,
    hvncVolume24hGatePassed,
    passesHvncPrereqs,
    mcapAlertTokenAgeGatePassed,
    recentSurgeAgeGatePassed,
    oldWeekSurgeAgeGatePassed,
    meteoraHasPool,
    meteoraMinTvlGatePassed,
    meteoraBaseline1hGatePassed,
    passesMeteoraPrereqs: meteoraHasPool && meteoraMinTvlGatePassed && meteoraBaseline1hGatePassed,
  };
}

function buildTokenAlertSignals(input = {}, options = {}) {
  const nowMs = firstNumber(
    options.nowMs,
    options.now instanceof Date ? options.now.getTime() : null,
    Date.now(),
  );
  const facts = normalizeCoreFacts(input, nowMs);
  const meteora = normalizeMeteora(input);
  const flags = buildSignalFlags(facts, meteora, nowMs);

  return {
    address: facts.address,
    alertSource: facts.alertSource,
    generatedAt: new Date(nowMs).toISOString(),
    currentVolume5m: facts.currentVolume5m,
    currentVolume1m: facts.currentVolume1m,
    prevVolume5m: facts.prevVolume5m,
    prevVolume1m: facts.prevVolume1m,
    currentMcap: facts.currentMcap,
    prevMcap: facts.prevMcap,
    volume24h: facts.volume24h,
    tokenCreatedAt: facts.tokenCreatedAt,
    currentPriceChange1h: facts.currentPriceChange1h,
    prevPriceChange1h: facts.prevPriceChange1h,
    currentPriceChange6h: facts.currentPriceChange6h,
    prevPriceChange6h: facts.prevPriceChange6h,
    ageMs: flags.ageMs,
    migrationAgeMs: flags.migrationAgeMs,
    vol5mChangePct: flags.vol5mChangePct,
    vol1mChangePct: flags.vol1mChangePct,
    mcapChangePct: flags.mcapChangePct,
    isMcapDeclining: flags.isMcapDeclining,
    hasVol5mBaseline: facts.prevVolume5m != null && facts.prevVolume5m > 0,
    hasVol1mBaseline: facts.prevVolume1m != null && facts.prevVolume1m > 0,
    hasMcapBaseline: facts.prevMcap != null && facts.prevMcap > 0,
    mcapAlertTokenAgeGatePassed: flags.mcapAlertTokenAgeGatePassed,
    hvncAgeGatePassed: flags.hvncAgeGatePassed,
    hvncVolume24hGatePassed: flags.hvncVolume24hGatePassed,
    passesHvncPrereqs: flags.passesHvncPrereqs,
    recentSurgeAgeGatePassed: flags.recentSurgeAgeGatePassed,
    oldWeekSurgeAgeGatePassed: flags.oldWeekSurgeAgeGatePassed,
    meteoraCurrentTvl: meteora.currentTvl,
    meteoraBaselineTvl1h: meteora.baselineTvl1h,
    meteoraBaselineTvl24h: meteora.baselineTvl24h,
    meteoraChange1h: meteora.change1h,
    meteoraChange24h: meteora.change24h,
    meteoraHasPool: flags.meteoraHasPool,
    meteoraMinTvlGatePassed: flags.meteoraMinTvlGatePassed,
    meteoraBaseline1hGatePassed: flags.meteoraBaseline1hGatePassed,
    passesMeteoraPrereqs: flags.passesMeteoraPrereqs,
  };
}

module.exports = {
  HVNC_MAX_AGE_MS,
  MCAP_ALERT_MIN_TOKEN_AGE_MS,
  METEORA_ALERT_MIN_TVL,
  OLD_WEEK_MIN_AGE_MS,
  SURGE_MIN_AGE_MS,
  buildTokenAlertSignals,
  __private: {
    computeAgeMs,
    computePctChange,
    deriveMeteoraBaselineTvl,
    buildSignalFlags,
    derivePctChangeFromBaseline,
    firstNumber,
    firstText,
    hasMeteoraState,
    normalizeCoreFacts,
    normalizeMeteora,
    readMeteoraBaselineTvl1h,
    readMeteoraBaselineTvl24h,
    readMeteoraChange1h,
    readMeteoraChange24h,
    readMeteoraCurrentTvl,
    toBoolean,
    toNumberOrNull,
  },
};
