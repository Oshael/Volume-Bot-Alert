const DEFAULT_SOURCE = 'coingecko_backfill';
const DEFAULT_MAX_GAP_SAMPLES = 10;
const ONE_MINUTE_PROTECTION_DAYS = 14;

function normalizeString(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function toFiniteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseGranularityMinutes(value, fallback = 5) {
  const raw = String(value ?? '').trim().toLowerCase();
  const normalized = raw.endsWith('m') ? raw.slice(0, -1) : raw;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getResultGranularityMinutes(result, fallback = 5) {
  if (result?.timeframe === 'minute') {
    return parseGranularityMinutes(result.aggregate, fallback);
  }
  return fallback;
}

function getTimestampMs(candle) {
  const timestampMs = Date.parse(candle?.bucketTs);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function getCandleRange(candles) {
  const sorted = Array.isArray(candles)
    ? candles.filter((candle) => getTimestampMs(candle) != null)
    : [];
  if (!sorted.length) {
    return { firstBucketAt: null, latestBucketAt: null };
  }
  sorted.sort((left, right) => getTimestampMs(left) - getTimestampMs(right));
  return {
    firstBucketAt: sorted[0].bucketTs,
    latestBucketAt: sorted[sorted.length - 1].bucketTs,
  };
}

function detectCandleGaps(candles, granularityMinutes, options = {}) {
  const expectedMs = Math.max(1, Number(granularityMinutes) || 1) * 60 * 1000;
  const maxSamples = Math.max(0, Number(options.maxSamples) || DEFAULT_MAX_GAP_SAMPLES);
  const sorted = (Array.isArray(candles) ? candles : [])
    .map((candle) => ({ candle, timestampMs: getTimestampMs(candle) }))
    .filter((item) => item.timestampMs != null)
    .sort((left, right) => left.timestampMs - right.timestampMs);

  let count = 0;
  let maxMissingBuckets = 0;
  const samples = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    const deltaMs = current.timestampMs - previous.timestampMs;
    if (deltaMs <= expectedMs * 1.5) continue;

    const missingBuckets = Math.max(1, Math.round(deltaMs / expectedMs) - 1);
    count += 1;
    maxMissingBuckets = Math.max(maxMissingBuckets, missingBuckets);
    if (samples.length < maxSamples) {
      samples.push({
        from: previous.candle.bucketTs,
        to: current.candle.bucketTs,
        deltaMinutes: Math.round(deltaMs / 60000),
        missingBuckets,
      });
    }
  }

  return { count, maxMissingBuckets, samples };
}

function resolveMcapMultiplier({ explicitMultiplier, catalogRow, latestClosePrice }) {
  const explicit = toFiniteNumber(explicitMultiplier);
  if (explicit != null && explicit > 0) {
    return {
      value: explicit,
      source: 'manual',
      mcap: null,
      price: latestClosePrice,
    };
  }

  const catalogMcap = toFiniteNumber(catalogRow?.last_mcap);
  if (catalogMcap != null && catalogMcap > 0 && latestClosePrice > 0) {
    return {
      value: catalogMcap / latestClosePrice,
      source: 'catalog_last_mcap_over_coingecko_latest_close',
      mcap: catalogMcap,
      price: latestClosePrice,
    };
  }

  return {
    value: null,
    source: null,
    mcap: catalogMcap,
    price: latestClosePrice,
  };
}

function scaleValue(value, multiplier) {
  const parsed = toFiniteNumber(value);
  return parsed != null && multiplier != null ? parsed * multiplier : null;
}

function toBackfillBucket(candle, context) {
  const multiplier = toFiniteNumber(context.mcapMultiplier);
  return {
    tokenAddress: context.tokenAddress,
    bucketTs: candle.bucketTs,
    pairAddress: context.poolAddress,
    granularityMinutes: context.granularityMinutes,
    openMcap: scaleValue(candle.open, multiplier),
    highMcap: scaleValue(candle.high, multiplier),
    lowMcap: scaleValue(candle.low, multiplier),
    closeMcap: scaleValue(candle.close, multiplier),
    openPrice: toFiniteNumber(candle.open),
    highPrice: toFiniteNumber(candle.high),
    lowPrice: toFiniteNumber(candle.low),
    closePrice: toFiniteNumber(candle.close),
    volume: toFiniteNumber(candle.volume, 0),
    sampleCount: 1,
    source: DEFAULT_SOURCE,
  };
}

function buildConvertedBucketStats(candles, context) {
  const converted = buildBackfillBuckets(candles, context);

  return {
    count: converted.length,
    first: converted[0] || null,
    latest: converted[converted.length - 1] || null,
    preview: converted.slice(0, 3),
  };
}

function buildBackfillBuckets(candles, context) {
  return (Array.isArray(candles) ? candles : [])
    .map((candle) => toBackfillBucket(candle, context))
    .filter((bucket) => bucket.bucketTs && bucket.closePrice != null);
}

function buildTokenSummary(tokenAddress, catalogRow) {
  return {
    address: tokenAddress,
    symbol: catalogRow?.symbol || null,
    name: catalogRow?.name || null,
    catalogFound: Boolean(catalogRow),
  };
}

function buildRequestSummary(result, input, granularityMinutes) {
  return {
    network: result.network || input.network || 'solana',
    days: Number(result.requestedDays || input.days || 0) || null,
    from: result.requestedFrom || input.from || null,
    to: result.requestedTo || input.to || null,
    granularityMinutes,
    calls: Number(result.calls) || 0,
  };
}

function buildCoingeckoSummary(candles, range, gaps) {
  return {
    hasHistory: candles.length > 0,
    candles: candles.length,
    firstBucketAt: range.firstBucketAt,
    latestBucketAt: range.latestBucketAt,
    gaps,
  };
}

function buildReplaceImpact(existing, range, convertedBuckets, granularityMinutes) {
  const baseRows = Number(existing.tokenMarketBuckets1mRows) || 0;
  const aggregateRows = Number(existing.tokenMarketBucketsAggRows) || 0;
  const rowsByGranularity = existing.tokenMarketBucketsAggRowsByGranularity || {};
  const targetsOneMinute = granularityMinutes === 1;
  const targetRows = targetsOneMinute
    ? baseRows
    : Number(rowsByGranularity[String(granularityMinutes)]) || 0;
  return {
    range,
    targetTable: targetsOneMinute ? 'token_market_buckets_1m' : 'token_market_buckets_agg',
    targetGranularityMinutes: granularityMinutes,
    tokenMarketBuckets1mRows: baseRows,
    tokenMarketBucketsAggRows: aggregateRows,
    tokenMarketBucketsAggRowsByGranularity: rowsByGranularity,
    wouldDeleteRows: targetRows,
    wouldInsertRows: convertedBuckets.count,
    wouldRebuildAggregates: [5, 15, 30, 60, 240, 1440]
      .filter((targetGranularity) => targetGranularity > granularityMinutes),
  };
}

function buildRecentProtection(range, granularityMinutes, now = new Date()) {
  if (granularityMinutes !== 1) {
    return {
      applies: false,
      days: 0,
      cutoffAt: null,
      overlapsProtectedRange: false,
    };
  }

  const nowMs = new Date(now).getTime();
  const cutoffMs = nowMs - (ONE_MINUTE_PROTECTION_DAYS * 24 * 60 * 60 * 1000);
  const latestMs = Date.parse(range.latestBucketAt);
  return {
    applies: true,
    days: ONE_MINUTE_PROTECTION_DAYS,
    cutoffAt: Number.isFinite(cutoffMs) ? new Date(cutoffMs).toISOString() : null,
    overlapsProtectedRange: Number.isFinite(latestMs) && latestMs >= cutoffMs,
  };
}

function buildReadiness(candles, multiplier, recentProtection) {
  const blockers = [];
  if (!candles.length) blockers.push('coingecko_history_missing');
  if (multiplier.value == null) blockers.push('mcap_multiplier_missing');
  if (recentProtection.overlapsProtectedRange) blockers.push('protected_recent_1m_range');
  return {
    canReplace: blockers.length === 0,
    blockers,
  };
}

function buildDryRunPlan(input = {}) {
  const result = input.result || {};
  const candles = Array.isArray(result.candles) ? result.candles : [];
  const tokenAddress = normalizeString(input.tokenAddress);
  const poolAddress = normalizeString(input.poolAddress || result.poolAddress);
  const granularityMinutes = getResultGranularityMinutes(result, parseGranularityMinutes(input.granularityMinutes, 5));
  const range = getCandleRange(candles);
  const latestClosePrice = toFiniteNumber(candles[candles.length - 1]?.close);
  const multiplier = resolveMcapMultiplier({
    explicitMultiplier: input.mcapMultiplier,
    catalogRow: input.catalogRow,
    latestClosePrice,
  });
  const gaps = detectCandleGaps(candles, granularityMinutes);
  const convertedBuckets = buildConvertedBucketStats(candles, {
    tokenAddress,
    poolAddress,
    granularityMinutes,
    mcapMultiplier: multiplier.value,
  });
  const existing = input.existing || {};
  const recentProtection = buildRecentProtection(range, granularityMinutes, input.now || new Date());

  return {
    mode: 'dry-run',
    writes: false,
    token: buildTokenSummary(tokenAddress, input.catalogRow),
    poolAddress,
    request: buildRequestSummary(result, input, granularityMinutes),
    coingecko: buildCoingeckoSummary(candles, range, gaps),
    mcapMultiplier: multiplier,
    convertedBuckets,
    replaceImpact: buildReplaceImpact(existing, range, convertedBuckets, granularityMinutes),
    recentProtection,
    readiness: buildReadiness(candles, multiplier, recentProtection),
  };
}

module.exports = {
  DEFAULT_SOURCE,
  ONE_MINUTE_PROTECTION_DAYS,
  buildDryRunPlan,
  buildBackfillBuckets,
  detectCandleGaps,
  parseGranularityMinutes,
  resolveMcapMultiplier,
  toBackfillBucket,
  __private: {
    buildRecentProtection,
    getCandleRange,
    getResultGranularityMinutes,
  },
};
