const express = require('express');
const router = express.Router();
const { authenticate, requireTrustedOrigin } = require('../middleware/auth');
const { dashboardLimiter } = require('../middleware/rate-limit');
const tokenCatalog = require('../models/token-catalog');
const tokenMarketBucket1m = require('../models/token-market-bucket-1m');
const tokenMarketVolumeBucket1m = require('../models/token-market-volume-bucket-1m');
const backendAlertFeed = require('../services/backend-alert-feed');
const uiMeteoraSummaryCache = require('../services/ui-meteora-summary-cache');
const alertTickerPeers = require('../services/alert-ticker-peers');
const { isValidAddress } = require('../models/user-token');
const { classifyTokenJunk } = require('../services/token-junk-metric');
const {
  buildBlockStatusSummary,
  buildEffectiveRiskLabel,
  buildRiskReviewSummary,
  buildStructuralRiskSummary,
  toNumberOrNull,
} = require('../services/token-risk-summary');
const { normalizeSocialLinkFields } = require('../utils/dex-social-links');

const MONITORED_MIN_MCAP = 30000;
const TOP_PERFORMERS_DEFAULT_LIMIT = 15;
const TOP_PERFORMERS_MAX_LIMIT = 20;
const TOP_PERFORMERS_MIN_VOL_24H = 200000;
const TOP_PERFORMERS_CACHE_TTL_MS = 30000;

let topPerformersCache = null;

function normalizeMinMcap(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : MONITORED_MIN_MCAP;
}

function normalizeMinVol24h(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : TOP_PERFORMERS_MIN_VOL_24H;
}

function toTimestampMsOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function parseOptionalEventId(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { ok: true, value: undefined };
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, error: `${name} must be a positive integer` };
  }

  return { ok: true, value: parsed };
}

function parseOptionalBoolean(value, name) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: false };
  }

  if (typeof value === 'boolean') {
    return { ok: true, value };
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return { ok: true, value: true };
  if (normalized === 'false') return { ok: true, value: false };
  return { ok: false, error: `${name} must be a boolean` };
}

function isValidHistorySortCriterion(mode, window) {
  return (
    (mode === 'vol' && (window === '1h' || window === '6h' || window === '24h'))
    || (mode === 'mcap' && (window === 'highest' || window === 'lowest'))
    || (mode === 'pchange' && (window === '1h' || window === '6h' || window === '24h'))
    || (mode === 'age' && (window === 'newest' || window === 'oldest'))
  );
}

function parseNonNegativeInteger(value, name, { min = 0, max = 500 } = {}) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isInteger(parsed)) {
    return { ok: false, error: `${name} must be an integer` };
  }
  if (parsed < min || parsed > max) {
    return { ok: false, error: `${name} must be between ${min} and ${max}` };
  }
  return { ok: true, value: parsed };
}

function parseSorts(value, name) {
  if (!Array.isArray(value)) {
    return { ok: false, error: `${name} must be an array` };
  }

  const next = [];
  const seen = new Set();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: `${name} entries must be objects` };
    }

    const mode = String(item.mode || '').trim();
    const window = String(item.window || '').trim();
    if (!isValidHistorySortCriterion(mode, window)) {
      return { ok: false, error: `${name} contains an invalid sort criterion` };
    }

    const key = `${mode}:${window}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push({ mode, window });
  }

  if (next.length === 0) {
    return { ok: false, error: `${name} must contain at least one sort criterion` };
  }

  return { ok: true, value: next.slice(0, 8) };
}

function parseAddressArray(value, name) {
  if (value === undefined || value === null) {
    return { ok: true, value: [] };
  }

  if (!Array.isArray(value)) {
    return { ok: false, error: `${name} must be an array` };
  }

  const next = [];
  const seen = new Set();
  for (const item of value) {
    const address = String(item || '').trim();
    if (!address) {
      continue;
    }
    if (!isValidAddress(address)) {
      return { ok: false, error: `${name} contains an invalid token address` };
    }
    if (seen.has(address)) {
      continue;
    }
    seen.add(address);
    next.push(address);
  }

  return { ok: true, value: next };
}

const DEFAULT_RECENT_AGE_MAX_MINUTES = 7 * 24 * 60;
const DEFAULT_OLD_WEEK_AGE_MIN_MINUTES = DEFAULT_RECENT_AGE_MAX_MINUTES;
const OPEN_ENDED_AGE_MAX_MINUTES = 100 * 365 * 24 * 60;

function parseAgeMinutesInput(value) {
  return Number.parseInt(String(value ?? '').trim(), 10);
}

function parseRecentHistoryBucketAgeRange(body = {}) {
  const parsedAgeMin = parseAgeMinutesInput(body.ageMinMinutes);
  const parsedAgeMax = parseAgeMinutesInput(body.ageMaxMinutes);
  const ageMinMinutes = Number.isInteger(parsedAgeMin)
    ? Math.max(0, Math.min(DEFAULT_RECENT_AGE_MAX_MINUTES, parsedAgeMin))
    : 0;
  const rawAgeMaxMinutes = Number.isInteger(parsedAgeMax)
    ? Math.max(0, Math.min(DEFAULT_RECENT_AGE_MAX_MINUTES, parsedAgeMax))
    : DEFAULT_RECENT_AGE_MAX_MINUTES;

  return {
    ageMinMinutes,
    ageMaxMinutes: Math.max(ageMinMinutes, rawAgeMaxMinutes),
  };
}

function parseOldWeekHistoryBucketAgeRange(body = {}) {
  const parsedAgeMin = parseAgeMinutesInput(body.ageMinMinutes);
  const parsedAgeMax = parseAgeMinutesInput(body.ageMaxMinutes);
  const ageMinMinutes = Number.isInteger(parsedAgeMin)
    ? Math.max(DEFAULT_OLD_WEEK_AGE_MIN_MINUTES, Math.min(OPEN_ENDED_AGE_MAX_MINUTES, parsedAgeMin))
    : DEFAULT_OLD_WEEK_AGE_MIN_MINUTES;
  const rawAgeMaxMinutes = Number.isInteger(parsedAgeMax)
    ? Math.max(0, Math.min(OPEN_ENDED_AGE_MAX_MINUTES, parsedAgeMax))
    : 0;

  return {
    ageMinMinutes,
    ageMaxMinutes: rawAgeMaxMinutes > 0 ? Math.max(ageMinMinutes, rawAgeMaxMinutes) : 0,
  };
}

function parseHistoryBucketAgeRange(body = {}, name) {
  return name === 'recent'
    ? parseRecentHistoryBucketAgeRange(body)
    : parseOldWeekHistoryBucketAgeRange(body);
}

function parseHistoryBucketRequest(body = {}, name) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: `${name} payload is required` };
  }

  const page = parseNonNegativeInteger(body.page, `${name}.page`, { min: 0, max: 10000 });
  if (!page.ok) return page;
  const perPage = parseNonNegativeInteger(body.perPage, `${name}.perPage`, { min: 10, max: 500 });
  if (!perPage.ok) return perPage;
  const starredOnly = parseOptionalBoolean(body.starredOnly, `${name}.starredOnly`);
  if (!starredOnly.ok) return starredOnly;
  const sorts = parseSorts(body.sorts, `${name}.sorts`);
  if (!sorts.ok) return sorts;
  const dismissed = parseAddressArray(body.dismissedAddresses, `${name}.dismissedAddresses`);
  if (!dismissed.ok) return dismissed;

  const mcapMin = normalizeMinMcap(body.mcapMin);
  const parsedMax = Number(body.mcapMax);
  const mcapMax = Number.isFinite(parsedMax) ? Math.max(0, parsedMax) : 0;
  const { ageMinMinutes, ageMaxMinutes } = parseHistoryBucketAgeRange(body, name);

  return {
    ok: true,
    value: {
      page: page.value,
      perPage: perPage.value,
      searchQuery: String(body.searchQuery || '').trim().slice(0, 120),
      starredOnly: starredOnly.value,
      sorts: sorts.value,
      dismissedAddresses: dismissed.value,
      mcapMin,
      mcapMax,
      ageMinMinutes,
      ageMaxMinutes,
    },
  };
}

function buildHistoryBootstrapPayload(recentResult, oldWeekResult, meteoraByAddress, marketMcapBaselineByAddress, marketVolumeBaselineByAddress) {
  return {
    generatedAt: new Date().toISOString(),
    recent: {
      total: recentResult.total,
      page: recentResult.page,
      perPage: recentResult.perPage,
      count: recentResult.rows.length,
      tokens: recentResult.rows.map((item) => buildMonitoredTokenPayload(item, meteoraByAddress, marketMcapBaselineByAddress, marketVolumeBaselineByAddress)),
    },
    oldWeek: {
      total: oldWeekResult.total,
      page: oldWeekResult.page,
      perPage: oldWeekResult.perPage,
      count: oldWeekResult.rows.length,
      tokens: oldWeekResult.rows.map((item) => buildMonitoredTokenPayload(item, meteoraByAddress, marketMcapBaselineByAddress, marketVolumeBaselineByAddress)),
    },
  };
}

router.use(authenticate);

function computePctChange(currentValue, baselineValue) {
  const current = Number(currentValue);
  const baseline = Number(baselineValue);
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || !(current > 0) || !(baseline > 0)) {
    return null;
  }

  const pct = ((current - baseline) / baseline) * 100;
  return Math.abs(pct) < 0.01 ? null : pct;
}

function buildMeteoraSummary(address, summaryRow) {
  if (!summaryRow) {
    return {
      address,
      tvl: null,
      poolAddress: null,
      poolCount: 0,
      lastCheckedAt: null,
      lastSnapshotAt: null,
      change1h: null,
      change6h: null,
      change24h: null,
      noPool: true,
    };
  }

  const latestTvl = Number(summaryRow.currentTvl);
  const hasPool = summaryRow.hasPool === true && Number.isFinite(latestTvl) && latestTvl > 0;
  return {
    address,
    tvl: hasPool ? latestTvl : null,
    poolAddress: hasPool ? (summaryRow.bestPoolAddress || null) : null,
    poolCount: hasPool ? (Number(summaryRow.poolCount) || 0) : 0,
    lastCheckedAt: summaryRow.lastCheckedAt || null,
    lastSnapshotAt: summaryRow.lastSnapshotAt || null,
    change1h: hasPool ? computePctChange(summaryRow.currentTvl, summaryRow.baselineTvl1h) : null,
    change6h: hasPool ? computePctChange(summaryRow.currentTvl, summaryRow.baselineTvl6h) : null,
    change24h: hasPool ? computePctChange(summaryRow.currentTvl, summaryRow.baselineTvl24h) : null,
    noPool: !hasPool,
  };
}

function buildMarketBaseline(mcapBaselineRow, volumeBaselineRow) {
  const currentMcap = toNumberOrNull(mcapBaselineRow?.current_mcap);
  const previousMcap = toNumberOrNull(mcapBaselineRow?.baseline_mcap);
  const previousVolume5m = toNumberOrNull(volumeBaselineRow?.baseline_vol_5m);
  const mcapDelta = currentMcap != null && previousMcap != null && previousMcap > 0
    ? ((currentMcap - previousMcap) / previousMcap) * 100
    : null;

  return {
    prevMcap: Number.isFinite(previousMcap) ? previousMcap : null,
    mcapDelta: Number.isFinite(mcapDelta) ? mcapDelta : null,
    prevVolume5mCanonical: Number.isFinite(previousVolume5m) ? previousVolume5m : null,
  };
}

function buildMonitoredTokenPayload(item, meteoraByAddress, marketMcapBaselineByAddress, marketVolumeBaselineByAddress, options = {}) {
  const includeRisk = options.includeRisk !== false;
  const includeMeteora = options.includeMeteora !== false;
  const marketBaseline = buildMarketBaseline(
    marketMcapBaselineByAddress.get(item.address) || null,
    marketVolumeBaselineByAddress.get(item.address) || null
  );
  const meteora = includeMeteora
    ? buildMeteoraSummary(item.address, meteoraByAddress.get(item.address) || null)
    : null;
  const socialLinks = normalizeSocialLinkFields({
    twitterUrl: item.last_twitter_url,
    communityUrl: item.last_community_url,
  });

  const payload = {
    address: item.address,
    symbol: item.symbol || null,
    name: item.name || null,
    pairAddress: item.last_pair_address || null,
    pairUrl: item.last_pair_url || null,
    imageUrl: item.last_image_url || null,
    twitterUrl: socialLinks.twitterUrl,
    communityUrl: socialLinks.communityUrl,
    eligibleForMonitoring: Boolean(item.eligible_for_monitoring),
    monitorPriority: item.monitor_priority || 'dormant',
    mcap: toNumberOrNull(item.last_mcap),
    priceUsd: toNumberOrNull(item.last_price),
    volume5m: toNumberOrNull(item.last_vol_5m),
    volume1h: toNumberOrNull(item.last_vol_1h),
    volume6h: toNumberOrNull(item.last_vol_6h),
    volume24h: toNumberOrNull(item.last_vol_24h),
    priceChange1h: toNumberOrNull(item.last_price_change_1h),
    priceChange6h: toNumberOrNull(item.last_price_change_6h),
    priceChange24h: toNumberOrNull(item.last_price_change_24h),
    tokenCreatedAt: toNumberOrNull(item.last_token_created_at_ms),
    catalogFirstSeenAt: toTimestampMsOrNull(item.first_seen_at),
    prevMcap: marketBaseline.prevMcap,
    mcapDelta: marketBaseline.mcapDelta,
    prevVolume5mCanonical: marketBaseline.prevVolume5mCanonical,
    lastSeenAt: item.last_seen_at || null,
    lastEvaluatedAt: item.last_evaluated_at || null,
    tickerPeers: options.tickerPeersByAddress?.get(item.address) || null,
  };

  if (includeRisk) {
    payload.blockStatus = buildBlockStatusSummary(item);
    payload.effectiveRiskLabel = buildEffectiveRiskLabel(item);
    payload.riskReview = buildRiskReviewSummary(item);
    payload.structuralRisk = buildStructuralRiskSummary(item);
    payload.junkAssessment = classifyTokenJunk({
      ...item,
      meteora,
    });
  }

  if (includeMeteora) {
    payload.meteora = meteora;
  }

  return payload;
}

function buildTopPerformersPayload(rows, options = {}) {
  const emptyMeteoraByAddress = new Map();
  const emptyMarketMcapBaselineByAddress = new Map();
  const emptyMarketVolumeBaselineByAddress = new Map();
  return {
    generatedAt: new Date().toISOString(),
    source: 'token_catalog',
    ranking: 'split_volume24h_7_pchange24h_8',
    minMcap: options.minMcap,
    minVol24h: options.minVol24h,
    count: rows.length,
    tokens: rows.map((item, index) => ({
      ...buildMonitoredTokenPayload(
        item,
        emptyMeteoraByAddress,
        emptyMarketMcapBaselineByAddress,
        emptyMarketVolumeBaselineByAddress,
        { includeMeteora: false, includeRisk: false }
      ),
      performanceRank: index + 1,
      performanceScore: toNumberOrNull(item.performance_score),
    })),
  };
}

function getTopPerformersCacheKey(options) {
  return JSON.stringify({
    limit: options.limit,
    minMcap: options.minMcap,
    minVol24h: options.minVol24h,
  });
}

function getCachedTopPerformersPayload(cacheKey, nowMs = Date.now()) {
  if (!topPerformersCache || topPerformersCache.key !== cacheKey || topPerformersCache.expiresAt <= nowMs) {
    return null;
  }
  return {
    ...topPerformersCache.payload,
    cached: true,
    cacheAgeMs: nowMs - topPerformersCache.createdAt,
  };
}

function setCachedTopPerformersPayload(cacheKey, payload, nowMs = Date.now()) {
  topPerformersCache = {
    key: cacheKey,
    payload,
    createdAt: nowMs,
    expiresAt: nowMs + TOP_PERFORMERS_CACHE_TTL_MS,
  };
}

function resetTopPerformersCache() {
  topPerformersCache = null;
}

function parseMonitoredSliceQuery(query) {
  if (query?.page === undefined && query?.perPage === undefined) {
    return { ok: true, value: null };
  }

  const page = query?.page === undefined
    ? { ok: true, value: 0 }
    : parseNonNegativeInteger(query.page, 'page', { min: 0, max: 1000 });
  if (!page.ok) {
    return page;
  }

  const perPage = query?.perPage === undefined
    ? { ok: true, value: 30 }
    : parseNonNegativeInteger(query.perPage, 'perPage', { min: 1, max: 500 });
  if (!perPage.ok) {
    return perPage;
  }

  return {
    ok: true,
    value: {
      page: page.value,
      perPage: perPage.value,
    },
  };
}

function parseMonitoredSortsQuery(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { ok: true, value: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    return { ok: false, error: 'sorts must be valid JSON' };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'sorts must be an array' };
  }

  const toSortEntry = (item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: 'sorts entries must be objects' };
    }

    const mode = String(item.mode || '').trim();
    const window = String(item.window || '').trim();
    const valid = (
      (mode === 'vol' && (window === '5m' || window === '1h' || window === '6h' || window === '24h'))
      || (mode === 'mcap' && (window === 'highest' || window === 'lowest'))
      || (mode === 'age' && (window === 'newest' || window === 'oldest'))
    );
    if (!valid) {
      return { ok: false, error: 'sorts contains an invalid monitored sort criterion' };
    }

    return { ok: true, value: { mode, window } };
  };

  const next = [];
  const seen = new Set();
  for (const item of parsed) {
    const normalized = toSortEntry(item);
    if (!normalized.ok) {
      return normalized;
    }

    const key = `${normalized.value.mode}:${normalized.value.window}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(normalized.value);
    if (next.length >= 8) {
      break;
    }
  }

  return { ok: true, value: next };
}

async function loadTickerPeerSummariesSafe(items = []) {
  try {
    return await alertTickerPeers.listTickerPeerSummariesForTokens(items);
  } catch (err) {
    console.warn('[Dashboard] Failed to load monitored ticker peer summaries:', err.message);
    return new Map();
  }
}

async function buildLeanMonitoredDashboardResponse(items, minMcap, pagination = null) {
  const addresses = items.map((item) => item.address);
  const emptyMeteoraByAddress = new Map();
  const marketMcapBaselineByAddress = new Map();
  const marketVolumeBaselineByAddress = new Map();

  const [primaryMarketBaselineRows, primaryVolumeBaselineRows, tickerPeersByAddress] = await Promise.all([
    tokenMarketBucket1m.listCurrentAndBaselineByAddresses(addresses, 5),
    tokenMarketVolumeBucket1m.listCurrentAndBaselineByAddresses(addresses, 5),
    loadTickerPeerSummariesSafe(items),
  ]);

  for (const row of primaryMarketBaselineRows) {
    marketMcapBaselineByAddress.set(row.token_address, row);
  }

  for (const row of primaryVolumeBaselineRows) {
    marketVolumeBaselineByAddress.set(row.token_address, row);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'token_catalog',
    minMcap,
    count: items.length,
    tokens: items.map((item) => buildMonitoredTokenPayload(
      item,
      emptyMeteoraByAddress,
      marketMcapBaselineByAddress,
      marketVolumeBaselineByAddress,
      { includeMeteora: false, includeRisk: false, tickerPeersByAddress }
    )),
  };

  if (!pagination) {
    return payload;
  }

  return {
    ...payload,
    total: pagination.total,
    page: pagination.page,
    perPage: pagination.perPage,
    hasMore: ((pagination.page + 1) * pagination.perPage) < pagination.total,
  };
}

router.get('/monitored', dashboardLimiter, async (req, res) => {
  const monitoredSliceQuery = parseMonitoredSliceQuery(req.query);
  if (!monitoredSliceQuery.ok) {
    return res.status(400).json({ error: monitoredSliceQuery.error });
  }
  const monitoredSortsQuery = parseMonitoredSortsQuery(req.query?.sorts);
  if (!monitoredSortsQuery.ok) {
    return res.status(400).json({ error: monitoredSortsQuery.error });
  }

  try {
    const minMcap = normalizeMinMcap(req.query?.minMcap);
    if (monitoredSliceQuery.value) {
      const monitoredSlice = await tokenCatalog.listDashboardMonitoredSlice(
        monitoredSliceQuery.value.page,
        monitoredSliceQuery.value.perPage,
        minMcap,
        monitoredSortsQuery.value,
      );
      return res.json(await buildLeanMonitoredDashboardResponse(monitoredSlice.rows, minMcap, monitoredSlice));
    }

    const tokens = await tokenCatalog.listDashboardMonitored(req.query?.limit, minMcap);
    res.json(await buildLeanMonitoredDashboardResponse(tokens, minMcap));
  } catch (err) {
    console.error('GET /dashboard/monitored error:', err.message);
    res.status(500).json({ error: 'Failed to load monitored dashboard' });
  }
});

router.get('/top-performers', dashboardLimiter, async (req, res) => {
  const parsedLimit = req.query?.limit === undefined
    ? { ok: true, value: TOP_PERFORMERS_DEFAULT_LIMIT }
    : parseNonNegativeInteger(req.query.limit, 'limit', { min: 1, max: TOP_PERFORMERS_MAX_LIMIT });
  if (!parsedLimit.ok) {
    return res.status(400).json({ error: parsedLimit.error });
  }

  const options = {
    limit: parsedLimit.value,
    minMcap: normalizeMinMcap(req.query?.minMcap),
    minVol24h: normalizeMinVol24h(req.query?.minVol24h),
  };
  const cacheKey = getTopPerformersCacheKey(options);
  const cached = getCachedTopPerformersPayload(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    const rows = await tokenCatalog.listDashboardTopPerformers(options);
    const payload = {
      ...buildTopPerformersPayload(rows, options),
      cached: false,
      cacheTtlMs: TOP_PERFORMERS_CACHE_TTL_MS,
    };
    setCachedTopPerformersPayload(cacheKey, payload);
    return res.json(payload);
  } catch (err) {
    console.error('GET /dashboard/top-performers error:', err.message);
    return res.status(500).json({ error: 'Failed to load top performers' });
  }
});

router.post('/history-bootstrap', dashboardLimiter, requireTrustedOrigin, async (req, res) => {
  const starredAddresses = parseAddressArray(req.body?.starredTokens, 'starredTokens');
  if (!starredAddresses.ok) {
    return res.status(400).json({ error: starredAddresses.error });
  }

  const recent = parseHistoryBucketRequest(req.body?.recent, 'recent');
  if (!recent.ok) {
    return res.status(400).json({ error: recent.error });
  }

  const oldWeek = parseHistoryBucketRequest(req.body?.oldWeek, 'oldWeek');
  if (!oldWeek.ok) {
    return res.status(400).json({ error: oldWeek.error });
  }

  try {
    const [recentResult, oldWeekResult] = await Promise.all([
      tokenCatalog.listDashboardHistoryBucket('recent', {
        ...recent.value,
        starredAddresses: starredAddresses.value,
      }),
      tokenCatalog.listDashboardHistoryBucket('oldWeek', {
        ...oldWeek.value,
        starredAddresses: starredAddresses.value,
      }),
    ]);

    const addresses = Array.from(new Set([
      ...recentResult.rows.map((item) => item.address),
      ...oldWeekResult.rows.map((item) => item.address),
    ]));

    const meteoraSummaryRows = await uiMeteoraSummaryCache.listUiSummaryByAddresses(addresses);
    const meteoraByAddress = new Map();
    const marketMcapBaselineByAddress = new Map();
    const marketVolumeBaselineByAddress = new Map();

    for (const row of meteoraSummaryRows) {
      meteoraByAddress.set(row.tokenAddress, row);
    }

    const [primaryMarketBaselineRows, primaryVolumeBaselineRows] = await Promise.all([
      tokenMarketBucket1m.listCurrentAndBaselineByAddresses(addresses, 5),
      tokenMarketVolumeBucket1m.listCurrentAndBaselineByAddresses(addresses, 5),
    ]);

    for (const row of primaryMarketBaselineRows) {
      marketMcapBaselineByAddress.set(row.token_address, row);
    }

    for (const row of primaryVolumeBaselineRows) {
      marketVolumeBaselineByAddress.set(row.token_address, row);
    }

    const payload = buildHistoryBootstrapPayload(
      recentResult,
      oldWeekResult,
      meteoraByAddress,
      marketMcapBaselineByAddress,
      marketVolumeBaselineByAddress,
    );

    res.json(payload);
  } catch (err) {
    console.error('POST /dashboard/history-bootstrap error:', err.message);
    res.status(500).json({ error: 'Failed to load history workspace bootstrap' });
  }
});

router.get('/alert-events', dashboardLimiter, async (req, res) => {
  const afterId = parseOptionalEventId(req.query?.afterId, 'afterId');
  if (!afterId.ok) {
    return res.status(400).json({ error: afterId.error });
  }

  try {
    const payload = await backendAlertFeed.listDashboardAlertEvents({
      userId: req.user.id,
      ruleKey: req.query?.ruleKey,
      limit: req.query?.limit,
      mode: req.query?.mode,
      afterId: afterId.value,
    });
    res.json(payload);
  } catch (err) {
    if (err.code === 'UNSUPPORTED_ALERT_RULE') {
      res.status(400).json({ error: 'Unsupported dashboard alert rule key' });
      return;
    }
    console.error('GET /dashboard/alert-events error:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard alert events' });
  }
});

router.get('/alert-feeds', dashboardLimiter, async (req, res) => {
  try {
    const payload = await backendAlertFeed.listDashboardAlertFeeds({
      userId: req.user.id,
      ruleKeys: req.query?.ruleKeys,
      limit: req.query?.limit,
      mode: req.query?.mode,
    });
    res.json(payload);
  } catch (err) {
    if (err.code === 'UNSUPPORTED_ALERT_RULE') {
      res.status(400).json({ error: 'Unsupported dashboard alert rule key' });
      return;
    }
    console.error('GET /dashboard/alert-feeds error:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard alert feeds' });
  }
});

router.post('/alert-events/cursor', dashboardLimiter, requireTrustedOrigin, async (req, res) => {
  const lastSeenEventId = parseOptionalEventId(req.body?.lastSeenEventId, 'lastSeenEventId');
  if (!lastSeenEventId.ok) {
    return res.status(400).json({ error: lastSeenEventId.error });
  }

  const lastAckedEventId = parseOptionalEventId(req.body?.lastAckedEventId, 'lastAckedEventId');
  if (!lastAckedEventId.ok) {
    return res.status(400).json({ error: lastAckedEventId.error });
  }

  if (lastSeenEventId.value == null && lastAckedEventId.value == null) {
    return res.status(400).json({ error: 'lastSeenEventId or lastAckedEventId is required' });
  }

  try {
    const cursor = await backendAlertFeed.updateDashboardAlertCursor(req.user.id, {
      ruleKey: req.body?.ruleKey,
      lastSeenEventId: lastSeenEventId.value,
      lastAckedEventId: lastAckedEventId.value,
    });

    res.json({ cursor });
  } catch (err) {
    if (err.code === 'UNSUPPORTED_ALERT_RULE') {
      res.status(400).json({ error: 'Unsupported dashboard alert rule key' });
      return;
    }
    console.error('POST /dashboard/alert-events/cursor error:', err.message);
    res.status(500).json({ error: 'Failed to update dashboard alert cursor' });
  }
});

router.__private = {
  buildMeteoraSummary,
  buildMarketBaseline,
  buildMonitoredTokenPayload,
  buildTopPerformersPayload,
  buildRiskReviewSummary,
  buildStructuralRiskSummary,
  parseOptionalEventId,
  resetTopPerformersCache,
};

module.exports = router;
