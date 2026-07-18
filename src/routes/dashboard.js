const express = require('express');
const router = express.Router();
const { authenticate, requireTrustedOrigin } = require('../middleware/auth');
const { dashboardLimiter } = require('../middleware/rate-limit');
const tokenCatalog = require('../models/token-catalog');
const userBlocklist = require('../models/user-blocklist');
const userPinnedMonitoredToken = require('../models/user-pinned-monitored-token');
const userCustomAlertRule = require('../models/user-custom-alert-rule');
const tokenMarketBucket1m = require('../models/token-market-bucket-1m');
const tokenMarketVolumeBucket1m = require('../models/token-market-volume-bucket-1m');
const backendAlertFeed = require('../services/backend-alert-feed');
const uiMeteoraSummaryCache = require('../services/ui-meteora-summary-cache');
const alertTickerPeers = require('../services/alert-ticker-peers');
const dashboardChainReader = require('../services/dashboard-chain-reader');
const dashboardRadarReader = require('../services/dashboard-radar-reader');
const {
  buildDashboardMonitoredPayload,
  buildDashboardMonitoredToken,
} = require('../services/dashboard-monitored-response');
const workspaceChainReadiness = require('../services/workspace-chain-readiness');
const {
  ERROR_CODES: CUSTOM_ALERT_ERROR_CODES,
  evaluateCustomAlertCapability,
  getCustomAlertCapability,
} = require('../services/custom-alert-capability-policy');
const { normalizeAsOf } = require('../services/workspace-window-metrics');
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
const {
  getAvailableTokenChains,
  isRobinhoodTokenChainConfigured,
} = require('../utils/token-chain-availability');
const {
  normalizeTokenAddress,
  normalizeTokenChain,
  parseTokenIdentityKey,
  tokenIdentityKey,
} = require('../utils/token-identity');
const config = require('../../config');

const MONITORED_MIN_MCAP = 30000;
const MONITORED_MIN_FDV = 30000;
const TOP_PERFORMERS_DEFAULT_LIMIT = 15;
const TOP_PERFORMERS_MAX_LIMIT = 20;
const TOP_PERFORMERS_MIN_VOL_24H = 200000;
const TOP_PERFORMERS_CACHE_TTL_MS = 30000;
const MONITORED_CACHE_TTL_MS = 5000;
const MONITORED_CACHE_MAX_ENTRIES = 500;
const MONITORED_CACHE_VERSION = 2;

const topPerformersCache = new Map();
const monitoredCache = new Map();

function normalizeMinMcap(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : MONITORED_MIN_MCAP;
}

function normalizeMinFdv(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : MONITORED_MIN_FDV;
}

function normalizeMaxValuation(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
}

function parseMonitoredValuationFilters(query, chains) {
  const value = {
    chains,
    minMcap: normalizeMinMcap(query?.minMcap),
    maxMcap: normalizeMaxValuation(query?.maxMcap),
    minFdv: normalizeMinFdv(query?.minFdv),
    maxFdv: normalizeMaxValuation(query?.maxFdv),
  };
  if ((value.maxMcap > 0 && value.maxMcap < value.minMcap)
    || (value.maxFdv > 0 && value.maxFdv < value.minFdv)) {
    return { ok: false, error: 'maximum valuation must not be below minimum' };
  }
  return { ok: true, value };
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

function toTextOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
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

function parseAvailableChainArray(value, name = 'chains') {
  const source = value == null ? ['solana'] : value;
  if (!Array.isArray(source) || source.length === 0) {
    return { ok: false, error: `${name} must be a non-empty array` };
  }

  const available = new Set(getAvailableTokenChains({
    robinhoodConfigured: isRobinhoodTokenChainConfigured(config),
  }));
  const chains = [];
  for (const item of source) {
    let chain;
    try {
      chain = normalizeTokenChain(item);
    } catch (_) {
      return { ok: false, error: `${name} contains an unsupported chain` };
    }
    if (!available.has(chain)) {
      return { ok: false, error: `${name} contains a chain that is not available` };
    }
    if (!chains.includes(chain)) {
      chains.push(chain);
    }
  }
  return { ok: true, value: chains };
}

function parseWorkspaceChainArray(value, name = 'chains') {
  let source = value == null ? ['solana'] : value;
  if (!Array.isArray(source)) {
    const text = String(source).trim();
    if (text.startsWith('[')) {
      try { source = JSON.parse(text); } catch (_) { source = []; }
    } else {
      source = text.split(',').map((item) => item.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(source) || source.length === 0) {
    return { ok: false, error: `${name} must select at least one chain` };
  }
  const available = new Set(getAvailableTokenChains({
    robinhoodConfigured: isRobinhoodTokenChainConfigured(config),
  }));
  const chains = [];
  for (const item of source) {
    let chain;
    try { chain = normalizeTokenChain(item); } catch (_) {
      return { ok: false, error: `${name} contains an unsupported chain` };
    }
    if (!available.has(chain)) {
      return { ok: false, error: `${name} contains a chain that is not available` };
    }
    if (!chains.includes(chain)) chains.push(chain);
  }
  return { ok: true, value: chains };
}

function parseCustomAlertChainArray(value, name = 'chains') {
  let source = value == null ? ['solana'] : value;
  if (!Array.isArray(source)) {
    const text = String(source).trim();
    if (text.startsWith('[')) {
      try { source = JSON.parse(text); } catch (_) { source = []; }
    } else {
      source = text.split(',').map((item) => item.trim()).filter(Boolean);
    }
  }
  if (source.length === 0) {
    return { ok: false, error: `${name} must select at least one chain` };
  }
  const chains = [];
  for (const valueItem of source) {
    const capability = getCustomAlertCapability({ chain: valueItem });
    if (!capability.supported) {
      return { ok: false, error: `${name} contains an unsupported chain` };
    }
    if (!chains.includes(capability.chain)) chains.push(capability.chain);
  }
  return { ok: true, value: chains };
}

function parseTokenIdentityArray(value, legacyValue, name) {
  if (value == null) {
    const legacy = parseAddressArray(legacyValue, name);
    return legacy.ok
      ? { ok: true, value: legacy.value.map((address) => tokenIdentityKey('solana', address)) }
      : legacy;
  }
  if (!Array.isArray(value)) {
    return { ok: false, error: `${name} must be an array` };
  }

  const identities = [];
  for (const item of value) {
    try {
      const identity = parseTokenIdentityKey(item);
      if (!identities.includes(identity.key)) {
        identities.push(identity.key);
      }
    } catch (_) {
      return { ok: false, error: `${name} contains an invalid token identity` };
    }
  }
  return { ok: true, value: identities };
}

function parsePinnedOrderItem(item, index) {
  let chain;
  let address;
  try {
    chain = normalizeTokenChain(typeof item === 'object' ? item?.chain || 'solana' : 'solana');
    address = normalizeTokenAddress(
      chain, typeof item === 'string' ? item : item?.address,
    );
  } catch (_) {
    return { ok: false, error: 'pinnedTokens contains an invalid token identity' };
  }
  const sortOrder = typeof item === 'object' && item?.sortOrder != null
    ? Number(item.sortOrder)
    : index;
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 1_000_000) {
    return { ok: false, error: 'pinnedTokens contains an invalid sortOrder' };
  }
  return { ok: true, value: { chain, address, sortOrder } };
}

function parsePinnedOrderPayload(body = {}) {
  const source = Array.isArray(body?.addresses) ? body.addresses : body?.pinnedTokens;
  if (!Array.isArray(source)) return { ok: false, error: 'addresses must be an array' };
  if (source.length > 500) return { ok: false, error: 'addresses must contain at most 500 token addresses' };

  const value = [];
  const seen = new Set();
  for (const [index, item] of source.entries()) {
    const parsed = parsePinnedOrderItem(item, index);
    if (!parsed.ok) return parsed;
    const key = tokenIdentityKey(parsed.value.chain, parsed.value.address);
    if (seen.has(key)) continue;
    seen.add(key);
    value.push(parsed.value);
  }
  const requestedChains = body.chains == null
    ? { ok: true, value: [...new Set(value.map((item) => item.chain))] }
    : parseWorkspaceChainArray(body.chains);
  if (!requestedChains.ok) return requestedChains;
  const chains = requestedChains.value.length ? requestedChains.value : ['solana'];
  if (value.some((item) => !chains.includes(item.chain))) {
    return { ok: false, error: 'pinnedTokens contains a chain outside chains' };
  }
  return { ok: true, value: { chains, items: value } };
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
  const perPage = parseNonNegativeInteger(body.perPage, `${name}.perPage`, { min: 10, max: 100 });
  if (!perPage.ok) return perPage;
  const starredOnly = parseOptionalBoolean(body.starredOnly, `${name}.starredOnly`);
  if (!starredOnly.ok) return starredOnly;
  const sorts = parseSorts(body.sorts, `${name}.sorts`);
  if (!sorts.ok) return sorts;
  const dismissed = parseTokenIdentityArray(
    body.dismissedTokenIdentities,
    body.dismissedAddresses,
    `${name}.dismissedTokenIdentities`,
  );
  if (!dismissed.ok) return dismissed;

  const mcapMin = normalizeMinMcap(body.mcapMin);
  const parsedMax = Number(body.mcapMax);
  const mcapMax = Number.isFinite(parsedMax) ? Math.max(0, parsedMax) : 0;
  const fdvMin = normalizeMinFdv(body.fdvMin);
  const parsedFdvMax = Number(body.fdvMax);
  const fdvMax = Number.isFinite(parsedFdvMax) ? Math.max(0, parsedFdvMax) : 0;
  const { ageMinMinutes, ageMaxMinutes } = parseHistoryBucketAgeRange(body, name);

  return {
    ok: true,
    value: {
      page: page.value,
      perPage: perPage.value,
      searchQuery: String(body.searchQuery || '').trim().slice(0, 120),
      starredOnly: starredOnly.value,
      sorts: sorts.value,
      dismissedTokenIdentities: dismissed.value,
      mcapMin,
      mcapMax,
      fdvMin,
      fdvMax,
      ageMinMinutes,
      ageMaxMinutes,
    },
  };
}

function parseHistoryBootstrapPinnedAddresses(body = {}) {
  const recentPinnedIdentities = parseTokenIdentityArray(
    body.recentPinnedIdentities,
    body.recentPinnedAddresses,
    'recentPinnedIdentities',
  );
  if (!recentPinnedIdentities.ok) {
    return recentPinnedIdentities;
  }

  const oldWeekPinnedIdentities = parseTokenIdentityArray(
    body.oldWeekPinnedIdentities,
    body.oldWeekPinnedAddresses,
    'oldWeekPinnedIdentities',
  );
  if (!oldWeekPinnedIdentities.ok) {
    return oldWeekPinnedIdentities;
  }

  return {
    ok: true,
    value: {
      recent: recentPinnedIdentities.value,
      oldWeek: oldWeekPinnedIdentities.value,
    },
  };
}

function filterTokenIdentitiesToChains(identities, chains) {
  const allowedChains = new Set(chains);
  return identities.filter((identityKey) => allowedChains.has(parseTokenIdentityKey(identityKey).chain));
}

function scopeHistoryBootstrapIdentitiesToChains(value) {
  const scope = (identities) => filterTokenIdentitiesToChains(identities, value.chains);
  return {
    ...value,
    starredIdentities: scope(value.starredIdentities),
    recentDebugProbeIdentities: scope(value.recentDebugProbeIdentities),
    pinnedIdentitiesByBucket: {
      recent: scope(value.pinnedIdentitiesByBucket.recent),
      oldWeek: scope(value.pinnedIdentitiesByBucket.oldWeek),
    },
    recent: {
      ...value.recent,
      dismissedTokenIdentities: scope(value.recent.dismissedTokenIdentities),
    },
    oldWeek: {
      ...value.oldWeek,
      dismissedTokenIdentities: scope(value.oldWeek.dismissedTokenIdentities),
    },
  };
}

function parseHistoryBootstrapRequestPayload(body = {}) {
  const parsed = {
    chains: parseAvailableChainArray(body.chains),
    starredIdentities: parseTokenIdentityArray(
      body.starredTokenIdentities,
      body.starredTokens,
      'starredTokenIdentities',
    ),
    recent: parseHistoryBucketRequest(body.recent, 'recent'),
    oldWeek: parseHistoryBucketRequest(body.oldWeek, 'oldWeek'),
    recentDebugProbeIdentities: parseTokenIdentityArray(
      body.recentDebugProbeIdentities,
      body.recentDebugProbeAddresses,
      'recentDebugProbeIdentities',
    ),
    pinnedIdentitiesByBucket: parseHistoryBootstrapPinnedAddresses(body),
  };

  for (const result of Object.values(parsed)) {
    if (!result.ok) {
      return result;
    }
  }

  const value = Object.fromEntries(
    Object.entries(parsed).map(([key, result]) => [key, result.value])
  );
  return { ok: true, value: scopeHistoryBootstrapIdentitiesToChains(value) };
}

function buildRadarReaderInput(bucketName, bucket, common) {
  return {
    ...common,
    bucket: bucketName,
    page: bucket.page,
    perPage: bucket.perPage,
    searchQuery: bucket.searchQuery,
    starredOnly: bucket.starredOnly,
    sorts: bucket.sorts,
    dismissedIdentities: [...bucket.dismissedTokenIdentities, ...common.blockedIdentities],
    minMcap: bucket.mcapMin,
    maxMcap: bucket.mcapMax,
    minFdv: bucket.fdvMin,
    maxFdv: bucket.fdvMax,
    ageMinMinutes: bucket.ageMinMinutes,
    ageMaxMinutes: bucket.ageMaxMinutes,
  };
}

function buildRadarTokenPayload(row) {
  return buildDashboardMonitoredToken({
    ...row,
    tokenCreatedAt: row.tokenCreatedAt ?? row.tokenAge?.timestampMs ?? null,
    tokenAgeProvenance: row.tokenAgeProvenance ?? row.tokenAge?.provenance ?? 'unknown',
  });
}

function buildRadarBucketPayload(page, pinnedRows) {
  return {
    total: page.total,
    page: page.page,
    perPage: page.perPage,
    count: page.rows.length,
    hasMore: page.hasMore,
    tokens: page.rows.map(buildRadarTokenPayload),
    pinnedTokens: pinnedRows.map(buildRadarTokenPayload),
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
      change4h: null,
      change6h: null,
      change24h: null,
      volume1h: null,
      volume4h: null,
      volume24h: null,
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
    change4h: hasPool ? computePctChange(summaryRow.currentTvl, summaryRow.baselineTvl4h) : null,
    change6h: hasPool ? computePctChange(summaryRow.currentTvl, summaryRow.baselineTvl6h) : null,
    change24h: hasPool ? computePctChange(summaryRow.currentTvl, summaryRow.baselineTvl24h) : null,
    volume1h: hasPool ? summaryRow.volume1h : null,
    volume4h: hasPool ? summaryRow.volume4h : null,
    volume24h: hasPool ? summaryRow.volume24h : null,
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

function normalizePinnedSortOrder(value) {
  return value != null ? Number(value) : null;
}

function buildValuationPayload(item) {
  const isRobinhood = item.chain === 'robinhood';
  const mcap = isRobinhood ? null : toNumberOrNull(item.last_mcap);
  const fdv = toNumberOrNull(item.last_fdv);
  return {
    mcap,
    fdv,
    valuationType: mcap != null ? 'market-cap' : (fdv != null ? 'fdv' : null),
  };
}

function getDashboardLiquidityUsd(item) {
  if (item.chain === 'robinhood') return null;
  return toNumberOrNull(item.last_liquidity_usd);
}

function appendOptionalMonitoredPayload(payload, item, meteora, options) {
  if (options.includeRisk) {
    payload.blockStatus = buildBlockStatusSummary(item);
    payload.effectiveRiskLabel = buildEffectiveRiskLabel(item);
    payload.riskReview = buildRiskReviewSummary(item);
    payload.structuralRisk = buildStructuralRiskSummary(item);
    payload.junkAssessment = classifyTokenJunk({ ...item, meteora });
  }
  if (options.includeMeteora) payload.meteora = meteora;
  return payload;
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
    chain: item.chain || 'solana',
    address: item.address,
    symbol: item.symbol || null,
    name: item.name || null,
    pairAddress: item.last_pair_address || null,
    pairUrl: item.last_pair_url || null,
    pairDexId: toTextOrNull(item.last_dex_id),
    imageUrl: item.last_image_url || null,
    twitterUrl: socialLinks.twitterUrl,
    communityUrl: socialLinks.communityUrl,
    eligibleForMonitoring: Boolean(item.eligible_for_monitoring),
    monitorPriority: item.monitor_priority || 'dormant',
    ...buildValuationPayload(item),
    priceUsd: toNumberOrNull(item.last_price),
    liquidityUsd: getDashboardLiquidityUsd(item),
    volume5m: toNumberOrNull(item.last_vol_5m),
    volume1h: toNumberOrNull(item.last_vol_1h),
    volume6h: toNumberOrNull(item.last_vol_6h),
    volume24h: toNumberOrNull(item.last_vol_24h),
    priceChange1h: toNumberOrNull(item.last_price_change_1h),
    priceChange6h: toNumberOrNull(item.last_price_change_6h),
    priceChange24h: toNumberOrNull(item.last_price_change_24h),
    historySortScore: toNumberOrNull(item.history_sort_score),
    tokenCreatedAt: toNumberOrNull(item.last_token_created_at_ms),
    catalogFirstSeenAt: toTimestampMsOrNull(item.first_seen_at),
    pinnedSortOrder: normalizePinnedSortOrder(item.pinned_sort_order),
    prevMcap: marketBaseline.prevMcap,
    mcapDelta: marketBaseline.mcapDelta,
    prevVolume5mCanonical: marketBaseline.prevVolume5mCanonical,
    lastSeenAt: item.last_seen_at || null,
    lastEvaluatedAt: item.last_evaluated_at || null,
    tickerPeers: options.tickerPeersByAddress?.get(item.address) || null,
  };

  return appendOptionalMonitoredPayload(payload, item, meteora, {
    includeMeteora, includeRisk,
  });
}

function buildTopPerformersPayload(rows, options = {}) {
  const emptyMeteoraByAddress = new Map();
  const emptyMarketMcapBaselineByAddress = new Map();
  const emptyMarketVolumeBaselineByAddress = new Map();
  return {
    generatedAt: new Date().toISOString(),
    source: options.chains?.includes('robinhood') ? 'chain_read_models' : 'token_catalog',
    ranking: 'split_volume24h_7_pchange24h_8',
    chains: options.chains || ['solana'],
    minMcap: options.minMcap,
    minFdv: options.minFdv,
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
    chains: options.chains,
    limit: options.limit,
    minMcap: options.minMcap,
    minFdv: options.minFdv,
    minVol24h: options.minVol24h,
  });
}

function getCachedTopPerformersPayload(cacheKey, nowMs = Date.now()) {
  const cached = topPerformersCache.get(cacheKey);
  if (!cached || cached.expiresAt <= nowMs) {
    topPerformersCache.delete(cacheKey);
    return null;
  }
  return {
    ...cached.payload,
    cached: true,
    cacheAgeMs: nowMs - cached.createdAt,
  };
}

function setCachedTopPerformersPayload(cacheKey, payload, nowMs = Date.now()) {
  topPerformersCache.set(cacheKey, {
    payload,
    createdAt: nowMs,
    expiresAt: nowMs + TOP_PERFORMERS_CACHE_TTL_MS,
  });
}

function resetTopPerformersCache(chains = null) {
  if (!Array.isArray(chains) || !chains.length) {
    topPerformersCache.clear();
    return;
  }
  for (const key of topPerformersCache.keys()) {
    const cachedChains = JSON.parse(key).chains || [];
    if (chains.some((chain) => cachedChains.includes(chain))) {
      topPerformersCache.delete(key);
    }
  }
}

function getMonitoredCacheKey(input) {
  const identities = (values) => values.map((item) => (
    `${item.chain}:${item.address}:${item.sortOrder ?? ''}`
  )).sort();
  return JSON.stringify({
    version: MONITORED_CACHE_VERSION,
    userId: input.userId,
    asOf: input.asOf,
    chains: input.chains,
    page: input.page,
    perPage: input.perPage,
    preferCatalogValuation: input.preferCatalogValuation === true,
    sorts: input.sorts,
    minMcap: input.minMcap,
    maxMcap: input.maxMcap,
    minFdv: input.minFdv,
    maxFdv: input.maxFdv,
    blocked: identities(input.blockedItems),
    pinned: identities(input.pinnedItems),
  });
}

function getCachedMonitoredPayload(key, nowMs = Date.now()) {
  const cached = monitoredCache.get(key);
  if (!cached || cached.expiresAt <= nowMs) {
    monitoredCache.delete(key);
    return null;
  }
  return { ...cached.payload, cached: true, cacheAgeMs: nowMs - cached.createdAt };
}

function setCachedMonitoredPayload(key, payload, userId, nowMs = Date.now()) {
  if (monitoredCache.size >= MONITORED_CACHE_MAX_ENTRIES) {
    monitoredCache.delete(monitoredCache.keys().next().value);
  }
  monitoredCache.set(key, {
    payload, userId, createdAt: nowMs, expiresAt: nowMs + MONITORED_CACHE_TTL_MS,
  });
}

function resetMonitoredCache(userId = null) {
  if (userId == null) return monitoredCache.clear();
  for (const [key, value] of monitoredCache) {
    if (value.userId === userId) monitoredCache.delete(key);
  }
}

function parseMonitoredSliceQuery(query) {
  const page = query?.page === undefined
    ? { ok: true, value: 0 }
    : parseNonNegativeInteger(query.page, 'page', { min: 0, max: 499 });
  if (!page.ok) {
    return page;
  }

  const perPage = query?.perPage === undefined
    ? { ok: true, value: 30 }
    : parseNonNegativeInteger(query.perPage, 'perPage', { min: 1, max: 100 });
  if (!perPage.ok) {
    return perPage;
  }

  if ((page.value + 1) * perPage.value > 500) {
    return { ok: false, error: 'requested monitored prefix cannot exceed 500' };
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
    return { ok: true, value: [{ mode: 'vol', window: '5m' }] };
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

async function buildExactMonitoredDashboardResponse(page, pinnedRows, filters, coverage) {
  const mapped = buildDashboardMonitoredPayload(page, { pinnedRows, coverage });
  const solanaItems = [...mapped.tokens, ...mapped.pinnedTokens]
    .filter((item) => item.chain === 'solana');
  const addresses = [...new Set(solanaItems.map((item) => item.address))];
  const meteoraByAddress = new Map();
  const marketMcapBaselineByAddress = new Map();
  const marketVolumeBaselineByAddress = new Map();

  const [meteoraSummaryRows, primaryMarketBaselineRows, primaryVolumeBaselineRows, tickerPeersByAddress] = await Promise.all([
    uiMeteoraSummaryCache.listUiSummaryByAddresses(addresses),
    tokenMarketBucket1m.listCurrentAndBaselineByAddresses(addresses, 5),
    tokenMarketVolumeBucket1m.listCurrentAndBaselineByAddresses(addresses, 5),
    loadTickerPeerSummariesSafe(solanaItems),
  ]);

  for (const row of meteoraSummaryRows) {
    meteoraByAddress.set(row.tokenAddress, row);
  }

  for (const row of primaryMarketBaselineRows) {
    marketMcapBaselineByAddress.set(row.token_address, row);
  }

  for (const row of primaryVolumeBaselineRows) {
    marketVolumeBaselineByAddress.set(row.token_address, row);
  }

  const enrich = (item) => {
    if (item.chain !== 'solana') return item;
    return {
      ...item,
      ...buildMarketBaseline(
        marketMcapBaselineByAddress.get(item.address) || null,
        marketVolumeBaselineByAddress.get(item.address) || null,
      ),
      meteora: buildMeteoraSummary(item.address, meteoraByAddress.get(item.address) || null),
      tickerPeers: tickerPeersByAddress.get(item.address) || null,
    };
  };
  return {
    ...mapped,
    source: 'workspace-catalog-v2',
    chains: filters.chains,
    minMcap: filters.minMcap,
    maxMcap: filters.maxMcap,
    minFdv: filters.minFdv,
    maxFdv: filters.maxFdv,
    count: mapped.tokens.length,
    cached: false,
    cacheAgeMs: 0,
    tokens: mapped.tokens.map(enrich),
    pinnedTokens: mapped.pinnedTokens.map(enrich),
  };
}

router.get('/monitored', dashboardLimiter, async (req, res) => {
  const chainsQuery = parseWorkspaceChainArray(req.query?.chains);
  if (!chainsQuery.ok) {
    return res.status(400).json({ error: chainsQuery.error });
  }
  const monitoredSliceQuery = parseMonitoredSliceQuery(req.query);
  if (!monitoredSliceQuery.ok) {
    return res.status(400).json({ error: monitoredSliceQuery.error });
  }
  const monitoredSortsQuery = parseMonitoredSortsQuery(req.query?.sorts);
  if (!monitoredSortsQuery.ok) {
    return res.status(400).json({ error: monitoredSortsQuery.error });
  }
  const priorityQuery = parseOptionalBoolean(req.query?.priority, 'priority');
  if (!priorityQuery.ok) {
    return res.status(400).json({ error: priorityQuery.error });
  }

  let asOf;
  try {
    asOf = normalizeAsOf(req.query?.asOf || new Date()).toISOString();
  } catch (_) {
    return res.status(400).json({ error: 'asOf must be a valid timestamp' });
  }

  try {
    const parsedFilters = parseMonitoredValuationFilters(req.query, chainsQuery.value);
    if (!parsedFilters.ok) return res.status(400).json({ error: parsedFilters.error });
    const filters = parsedFilters.value;
    const [blockedItems, pinnedItems] = await Promise.all([
      userBlocklist.getAllForChains(req.user.id, filters.chains),
      userPinnedMonitoredToken.getAllForChains(req.user.id, filters.chains),
    ]);
    const requestInput = {
      ...filters, ...monitoredSliceQuery.value, asOf,
      sorts: monitoredSortsQuery.value,
      preferCatalogValuation: priorityQuery.value,
      excludedIdentities: blockedItems,
    };
    const cacheKey = getMonitoredCacheKey({
      ...requestInput, userId: req.user.id, blockedItems, pinnedItems,
    });
    const cached = getCachedMonitoredPayload(cacheKey);
    if (cached) return res.json(cached);

    const [page, pinnedRows, readiness] = await Promise.all([
      dashboardChainReader.listExactMonitored(requestInput),
      dashboardChainReader.listExactPinned({ ...requestInput, pinnedItems }),
      workspaceChainReadiness.getWorkspaceChainReadiness(),
    ]);
    const coverage = Object.fromEntries(filters.chains.map((chain) => [
      chain, readiness[chain]?.status || 'unavailable',
    ]));
    const payload = await buildExactMonitoredDashboardResponse(
      page, pinnedRows, filters, coverage,
    );
    setCachedMonitoredPayload(cacheKey, payload, req.user.id);
    return res.json(payload);
  } catch (err) {
    console.error('GET /dashboard/monitored error:', err.message);
    res.status(500).json({ error: 'Failed to load monitored dashboard' });
  }
});

router.get('/monitored-pins', dashboardLimiter, async (req, res) => {
  const chains = parseWorkspaceChainArray(req.query?.chains);
  if (!chains.ok) return res.status(400).json({ error: chains.error });
  try {
    const pinnedTokens = await userPinnedMonitoredToken.getAllForChains(
      req.user.id, chains.value,
    );
    return res.json({ pinnedTokens });
  } catch (err) {
    console.error('GET /dashboard/monitored-pins error:', err.message);
    return res.status(500).json({ error: 'Failed to load monitored pins' });
  }
});

router.put('/monitored-pins', dashboardLimiter, requireTrustedOrigin, async (req, res) => {
  const parsed = parsePinnedOrderPayload(req.body);
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }

  try {
    const pinnedTokens = await userPinnedMonitoredToken.setAllForChains(
      req.user.id, parsed.value.items, parsed.value.chains,
    );
    resetMonitoredCache(req.user.id);
    return res.json({ pinnedTokens });
  } catch (err) {
    console.error('PUT /dashboard/monitored-pins error:', err.message);
    return res.status(500).json({ error: 'Failed to save monitored pins' });
  }
});

router.delete('/monitored-pins', dashboardLimiter, requireTrustedOrigin, async (req, res) => {
  const chains = parseWorkspaceChainArray(req.query?.chains);
  if (!chains.ok) return res.status(400).json({ error: chains.error });
  try {
    const removed = await userPinnedMonitoredToken.removeAllForChains(
      req.user.id, chains.value,
    );
    resetMonitoredCache(req.user.id);
    return res.json({ removed });
  } catch (err) {
    console.error('DELETE /dashboard/monitored-pins error:', err.message);
    return res.status(500).json({ error: 'Failed to reset monitored pins' });
  }
});

router.delete('/monitored-pins/:address', dashboardLimiter, requireTrustedOrigin, async (req, res) => {
  const chains = parseWorkspaceChainArray(req.query?.chain);
  if (!chains.ok || chains.value.length !== 1) {
    return res.status(400).json({ error: chains.error || 'chain must select one chain' });
  }
  let address;
  try { address = normalizeTokenAddress(chains.value[0], req.params.address); } catch (_) {
    return res.status(400).json({ error: 'Invalid token address for chain' });
  }

  try {
    const removed = await userPinnedMonitoredToken.remove(
      req.user.id, address, chains.value[0],
    );
    resetMonitoredCache(req.user.id);
    return res.json({ removed });
  } catch (err) {
    console.error('DELETE /dashboard/monitored-pins/:address error:', err.message);
    return res.status(500).json({ error: 'Failed to remove monitored pin' });
  }
});

router.get('/custom-alert-rules', dashboardLimiter, async (req, res) => {
  const chains = parseCustomAlertChainArray(req.query?.chains ?? req.query?.chain);
  if (!chains.ok) return res.status(400).json({ error: chains.error });
  try {
    const readiness = await workspaceChainReadiness.getWorkspaceChainReadiness();
    const rules = await userCustomAlertRule.listRules(req.user.id, {
      chains: chains.value,
      status: req.query?.status,
    });
    return res.json({
      rules,
      count: rules.length,
      capabilities: buildCustomAlertCapabilities(chains.value, readiness),
    });
  } catch (err) {
    if (err.status === 400) return sendCustomAlertError(res, err);
    console.error('GET /dashboard/custom-alert-rules error:', err.message);
    return res.status(500).json({ error: 'Failed to load custom alert rules' });
  }
});

function getCustomAlertReadiness(chain, readiness = {}) {
  const value = readiness[chain];
  if (chain === 'solana') {
    return {
      ready: value?.capabilities?.customAlerts === true,
      reason: value?.capabilities?.customAlerts === true ? null : 'custom_alert_runtime_not_ready',
    };
  }
  const ready = value?.capabilities?.customAlerts === true
    && value?.publicationReady === true;
  const reason = ready
    ? null
    : value?.blockers?.[0]
      || (value?.publicationReady === true
        ? 'custom_alert_runtime_not_ready'
        : 'rollout_not_publishable');
  return { ready, reason };
}

function buildCustomAlertCapabilities(chains, readiness) {
  return Object.fromEntries(chains.map((chain) => {
    const state = getCustomAlertReadiness(chain, readiness);
    return [chain, getCustomAlertCapability({ chain, ...state })];
  }));
}

function sendCustomAlertError(res, error) {
  const status = error.code === CUSTOM_ALERT_ERROR_CODES.notReady ? 409 : 400;
  return res.status(status).json({
    error: error.message || 'Invalid custom alert request',
    code: error.code || null,
    reason: error.reason || null,
    capability: error.capability || null,
  });
}

function customAlertBaselineNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function validateCustomAlertMutation(payload = {}) {
  const readiness = await workspaceChainReadiness.getWorkspaceChainReadiness();
  const structural = getCustomAlertCapability({ chain: payload.chain || 'solana' });
  const chain = structural.chain || payload.chain;
  const state = getCustomAlertReadiness(chain, readiness);
  const result = evaluateCustomAlertCapability({
    chain,
    metric: payload.metric,
    window: payload.window,
    ...state,
  });
  if (result.ok) return result;
  const error = Object.assign(new Error(
    result.code === CUSTOM_ALERT_ERROR_CODES.notReady
      ? 'Custom alerts are not ready for this chain'
      : 'Unsupported custom alert chain, metric, or window'
  ), {
    status: 400,
    code: result.code,
    reason: result.reason,
    capability: result.capability,
  });
  throw error;
}

async function buildCustomAlertBaselineMetadata(chain, tokenAddress, metric) {
  try {
    const row = await tokenCatalog.getMarketBaselineByAddress(tokenAddress, chain);
    if (!row) return {};
    const baselineMcap = customAlertBaselineNumber(row.last_mcap);
    const baselineFdv = customAlertBaselineNumber(row.last_fdv);
    const baselinePrice = customAlertBaselineNumber(row.last_price);
    return {
      baselineMcap: chain === 'solana' ? baselineMcap : null,
      baselineFdv: chain === 'robinhood' ? baselineFdv : null,
      baselinePrice,
      baselineValuationType: metric === 'fdv' ? 'fdv' : (metric === 'mcap' ? 'market-cap' : 'price'),
      baselineAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error('Custom alert baseline lookup failed:', err.message);
    return {};
  }
}

router.post('/custom-alert-rules', dashboardLimiter, requireTrustedOrigin, async (req, res) => {
  try {
    const capability = await validateCustomAlertMutation(req.body);
    const metadata = await buildCustomAlertBaselineMetadata(
      capability.chain, req.body?.tokenAddress, capability.metric,
    );
    const rule = await userCustomAlertRule.createRule(req.user.id, {
      ...(req.body || {}),
      chain: capability.chain,
      metric: capability.metric,
      window: capability.window,
      metadata,
    });
    return res.status(201).json({ rule });
  } catch (err) {
    if (err.status === 400) return sendCustomAlertError(res, err);
    console.error('POST /dashboard/custom-alert-rules error:', err.message);
    return res.status(500).json({ error: 'Failed to create custom alert rule' });
  }
});

router.patch('/custom-alert-rules/:id', dashboardLimiter, requireTrustedOrigin, async (req, res) => {
  try {
    const capability = await validateCustomAlertMutation(req.body);
    const rule = await userCustomAlertRule.updateRule(req.params.id, req.user.id, {
      ...(req.body || {}),
      chain: capability.chain,
      metric: capability.metric,
      window: capability.window,
      metadata: {},
    });
    if (!rule) {
      return res.status(404).json({ error: 'Custom alert rule not found' });
    }
    return res.json({ rule });
  } catch (err) {
    if (err.status === 400) return sendCustomAlertError(res, err);
    console.error('PATCH /dashboard/custom-alert-rules/:id error:', err.message);
    return res.status(500).json({ error: 'Failed to update custom alert rule' });
  }
});

router.delete('/custom-alert-rules/:id', dashboardLimiter, requireTrustedOrigin, async (req, res) => {
  const chains = parseCustomAlertChainArray(req.query?.chain, 'chain');
  if (!chains.ok || chains.value.length !== 1) {
    return res.status(400).json({ error: chains.error || 'chain must select one chain' });
  }
  try {
    const rule = await userCustomAlertRule.disableRule(
      req.params.id, req.user.id, { chain: chains.value[0] },
    );
    return res.json({ rule, disabled: Boolean(rule) });
  } catch (err) {
    if (err.status === 400) return sendCustomAlertError(res, err);
    console.error('DELETE /dashboard/custom-alert-rules/:id error:', err.message);
    return res.status(500).json({ error: 'Failed to disable custom alert rule' });
  }
});

router.get('/top-performers', dashboardLimiter, async (req, res) => {
  const chainsQuery = parseWorkspaceChainArray(req.query?.chains);
  if (!chainsQuery.ok) {
    return res.status(400).json({ error: chainsQuery.error });
  }
  const parsedLimit = req.query?.limit === undefined
    ? { ok: true, value: TOP_PERFORMERS_DEFAULT_LIMIT }
    : parseNonNegativeInteger(req.query.limit, 'limit', { min: 1, max: TOP_PERFORMERS_MAX_LIMIT });
  if (!parsedLimit.ok) {
    return res.status(400).json({ error: parsedLimit.error });
  }

  const options = {
    chains: chainsQuery.value,
    limit: parsedLimit.value,
    minMcap: normalizeMinMcap(req.query?.minMcap),
    minFdv: normalizeMinFdv(req.query?.minFdv),
    minVol24h: normalizeMinVol24h(req.query?.minVol24h),
  };
  const cacheKey = getTopPerformersCacheKey(options);
  const cached = getCachedTopPerformersPayload(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    const rows = await dashboardChainReader.listTopPerformers(options);
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
  const parsed = parseHistoryBootstrapRequestPayload(req.body);
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }
  const {
    chains,
    oldWeek,
    pinnedIdentitiesByBucket,
    recent,
    starredIdentities,
  } = parsed.value;

  let asOf;
  try {
    asOf = normalizeAsOf(req.body?.asOf || new Date()).toISOString();
  } catch (_) {
    return res.status(400).json({ error: 'asOf must be a valid timestamp' });
  }

  try {
    const blockedItems = await userBlocklist.getAllForChains(req.user.id, chains);
    const blockedIdentities = blockedItems.map((item) => tokenIdentityKey(item.chain, item.address));
    const common = { asOf, chains, starredIdentities, blockedIdentities };
    const recentInput = buildRadarReaderInput('recent', recent, common);
    const oldWeekInput = buildRadarReaderInput('oldWeek', oldWeek, common);
    const [recentResult, oldWeekResult] = await Promise.all([
      dashboardRadarReader.listExactRadar(recentInput),
      dashboardRadarReader.listExactRadar(oldWeekInput),
    ]);
    const [recentPinnedRows, oldWeekPinnedRows] = await Promise.all([
      dashboardRadarReader.listRadarPins({ ...recentInput,
        pinnedIdentities: pinnedIdentitiesByBucket.recent,
        excludedIdentities: blockedIdentities, pageRows: recentResult.rows }),
      dashboardRadarReader.listRadarPins({ ...oldWeekInput,
        pinnedIdentities: pinnedIdentitiesByBucket.oldWeek,
        excludedIdentities: blockedIdentities, pageRows: oldWeekResult.rows }),
    ]);
    return res.json({
      generatedAt: asOf,
      asOf,
      chains,
      source: 'workspace-catalog-v2',
      recent: buildRadarBucketPayload(recentResult, recentPinnedRows),
      oldWeek: buildRadarBucketPayload(oldWeekResult, oldWeekPinnedRows),
    });
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
      ...((req.query?.chains ?? req.query?.chain) == null
        ? {} : { chains: req.query?.chains ?? req.query?.chain }),
    });
    res.json(payload);
  } catch (err) {
    if (err.code === 'UNSUPPORTED_ALERT_RULE') {
      res.status(400).json({ error: 'Unsupported dashboard alert rule key' });
      return;
    }
    if (err.code === 'UNSUPPORTED_ALERT_CHAIN') {
      res.status(400).json({ error: 'Unsupported dashboard alert chain' });
      return;
    }
    console.error('GET /dashboard/alert-events error:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard alert events' });
  }
});

router.get('/chart-alert-events', dashboardLimiter, async (req, res) => {
  const tokenAddress = String(req.query?.address || '').trim();
  if (!isValidAddress(tokenAddress)) {
    return res.status(400).json({ error: 'Valid token address is required' });
  }

  try {
    const payload = await backendAlertFeed.listDashboardChartAlertEvents({
      userId: req.user.id,
      tokenAddress,
    });
    res.json(payload);
  } catch (err) {
    console.error('GET /dashboard/chart-alert-events error:', err.message);
    res.status(500).json({ error: 'Failed to load chart alert events' });
  }
});

router.get('/alert-feeds', dashboardLimiter, async (req, res) => {
  try {
    const payload = await backendAlertFeed.listDashboardAlertFeeds({
      userId: req.user.id,
      ruleKeys: req.query?.ruleKeys,
      limit: req.query?.limit,
      mode: req.query?.mode,
      ...((req.query?.chains ?? req.query?.chain) == null
        ? {} : { chains: req.query?.chains ?? req.query?.chain }),
    });
    res.json(payload);
  } catch (err) {
    if (err.code === 'UNSUPPORTED_ALERT_RULE') {
      res.status(400).json({ error: 'Unsupported dashboard alert rule key' });
      return;
    }
    if (err.code === 'UNSUPPORTED_ALERT_CHAIN') {
      res.status(400).json({ error: 'Unsupported dashboard alert chain' });
      return;
    }
    console.error('GET /dashboard/alert-feeds error:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard alert feeds' });
  }
});

router.post('/alert-events/clear', dashboardLimiter, requireTrustedOrigin, async (req, res) => {
  try {
    const payload = await backendAlertFeed.clearDashboardAlertFeeds(req.user.id, {
      ruleKeys: req.body?.ruleKeys,
      ...((req.body?.chains ?? req.body?.chain) == null
        ? {} : { chains: req.body?.chains ?? req.body?.chain }),
    });
    res.json(payload);
  } catch (err) {
    if (err.code === 'UNSUPPORTED_ALERT_RULE') {
      res.status(400).json({ error: 'Unsupported dashboard alert rule key' });
      return;
    }
    if (err.code === 'UNSUPPORTED_ALERT_CHAIN') {
      res.status(400).json({ error: 'Unsupported dashboard alert chain' });
      return;
    }
    console.error('POST /dashboard/alert-events/clear error:', err.message);
    res.status(500).json({ error: 'Failed to clear dashboard alert events' });
  }
});

router.post('/alert-events/dismiss', dashboardLimiter, requireTrustedOrigin, async (req, res) => {
  const eventId = parseOptionalEventId(req.body?.eventId, 'eventId');
  if (!eventId.ok || eventId.value == null) {
    return res.status(400).json({ error: eventId.error || 'eventId is required' });
  }

  try {
    const dismissal = await backendAlertFeed.dismissDashboardAlertEvent(req.user.id, {
      ruleKey: req.body?.ruleKey,
      chain: req.body?.chain,
      eventId: eventId.value,
    });
    res.json({ dismissal });
  } catch (err) {
    if (err.code === 'ALERT_EVENT_NOT_FOUND') {
      res.status(404).json({ error: 'Dashboard alert event not found' });
      return;
    }
    if (['UNSUPPORTED_ALERT_RULE', 'UNSUPPORTED_ALERT_CHAIN', 'INVALID_ALERT_EVENT'].includes(err.code)) {
      res.status(400).json({ error: 'Invalid dashboard alert event dismissal' });
      return;
    }
    console.error('POST /dashboard/alert-events/dismiss error:', err.message);
    res.status(500).json({ error: 'Failed to dismiss dashboard alert event' });
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
      ...(req.body?.chain == null ? {} : { chain: req.body.chain }),
      lastSeenEventId: lastSeenEventId.value,
      lastAckedEventId: lastAckedEventId.value,
    });

    res.json({ cursor });
  } catch (err) {
    if (err.code === 'UNSUPPORTED_ALERT_RULE') {
      res.status(400).json({ error: 'Unsupported dashboard alert rule key' });
      return;
    }
    if (err.code === 'UNSUPPORTED_ALERT_CHAIN') {
      res.status(400).json({ error: 'Unsupported dashboard alert chain' });
      return;
    }
    console.error('POST /dashboard/alert-events/cursor error:', err.message);
    res.status(500).json({ error: 'Failed to update dashboard alert cursor' });
  }
});

router.__private = {
  buildMeteoraSummary,
  buildExactMonitoredDashboardResponse,
  buildMarketBaseline,
  buildMonitoredTokenPayload,
  buildValuationPayload,
  buildTopPerformersPayload,
  buildRiskReviewSummary,
  buildStructuralRiskSummary,
  parseOptionalEventId,
  parsePinnedOrderPayload,
  getMonitoredCacheKey,
  resetMonitoredCache,
  resetTopPerformersCache,
};

module.exports = router;
