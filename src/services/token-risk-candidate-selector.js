const tokenCatalog = require('../models/token-catalog');

const DEFAULT_SCAN_LIMIT = 250;
const DEFAULT_RESULT_LIMIT = 50;
const DEFAULT_FRESH_ENRICHMENT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ERROR_BACKOFF_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MIN_RELEVANT_MCAP = 30000;
const DEFAULT_MIN_RELEVANT_VOL_24H = 5000;
const DEFAULT_NEW_TOKEN_AGE_HOURS = 72;
const DEFAULT_STALE_ENRICHMENT_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_HIGH_VOL_TO_MCAP_RATIO = 1.5;
const DEFAULT_LARGE_PRICE_CHANGE_24H_PCT = 60;
const DEFAULT_LARGE_PRICE_CHANGE_6H_PCT = 35;
const DEFAULT_LOW_LIQUIDITY_TO_MCAP_RATIO = 0.05;
const DEFAULT_LOW_LIQUIDITY_MIN_MCAP = 150000;
const DEFAULT_HIGH_BUY_SELL_IMBALANCE_RATIO = 3;
const DEFAULT_MIN_BUY_SELL_TXNS_24H = 24;

function toNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toTimestampMs(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeLimit(value, fallback, max = 5000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.trunc(parsed), max));
}

function normalizeManualLabelMap(value) {
  if (value instanceof Map) {
    return value;
  }

  const map = new Map();
  if (!value || typeof value !== 'object') {
    return map;
  }

  for (const [address, label] of Object.entries(value)) {
    const normalizedAddress = String(address || '').trim();
    const normalizedLabel = String(label || '').trim().toLowerCase();
    if (normalizedAddress && normalizedLabel) {
      map.set(normalizedAddress, normalizedLabel);
    }
  }

  return map;
}

function normalizeSelectorOptions(options = {}) {
  return {
    scanLimit: normalizeLimit(options.scanLimit, DEFAULT_SCAN_LIMIT),
    resultLimit: normalizeLimit(options.resultLimit, DEFAULT_RESULT_LIMIT),
    freshEnrichmentTtlMs: normalizeLimit(options.freshEnrichmentTtlMs, DEFAULT_FRESH_ENRICHMENT_TTL_MS, Number.MAX_SAFE_INTEGER),
    staleEnrichmentMs: normalizeLimit(options.staleEnrichmentMs, DEFAULT_STALE_ENRICHMENT_MS, Number.MAX_SAFE_INTEGER),
    errorBackoffMs: normalizeLimit(options.errorBackoffMs, DEFAULT_ERROR_BACKOFF_MS, Number.MAX_SAFE_INTEGER),
    minRelevantMcap: Math.max(0, toNumberOrNull(options.minRelevantMcap) ?? DEFAULT_MIN_RELEVANT_MCAP),
    minRelevantVol24h: Math.max(0, toNumberOrNull(options.minRelevantVol24h) ?? DEFAULT_MIN_RELEVANT_VOL_24H),
    newTokenAgeHours: Math.max(1, toNumberOrNull(options.newTokenAgeHours) ?? DEFAULT_NEW_TOKEN_AGE_HOURS),
    highVolToMcapRatio: Math.max(0, toNumberOrNull(options.highVolToMcapRatio) ?? DEFAULT_HIGH_VOL_TO_MCAP_RATIO),
    largePriceChange24hPct: Math.max(0, toNumberOrNull(options.largePriceChange24hPct) ?? DEFAULT_LARGE_PRICE_CHANGE_24H_PCT),
    largePriceChange6hPct: Math.max(0, toNumberOrNull(options.largePriceChange6hPct) ?? DEFAULT_LARGE_PRICE_CHANGE_6H_PCT),
    lowLiquidityToMcapRatio: Math.max(0, toNumberOrNull(options.lowLiquidityToMcapRatio) ?? DEFAULT_LOW_LIQUIDITY_TO_MCAP_RATIO),
    lowLiquidityMinMcap: Math.max(0, toNumberOrNull(options.lowLiquidityMinMcap) ?? DEFAULT_LOW_LIQUIDITY_MIN_MCAP),
    highBuySellImbalanceRatio: Math.max(1, toNumberOrNull(options.highBuySellImbalanceRatio) ?? DEFAULT_HIGH_BUY_SELL_IMBALANCE_RATIO),
    minBuySellTxns24h: Math.max(0, Math.trunc(toNumberOrNull(options.minBuySellTxns24h) ?? DEFAULT_MIN_BUY_SELL_TXNS_24H)),
    manualLabelsByAddress: normalizeManualLabelMap(options.manualLabelsByAddress),
    nowMs: Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now(),
  };
}

function getManualLabel(row, manualLabelsByAddress) {
  const persisted = String(row?.risk_review_label || '').trim().toLowerCase();
  if (persisted) {
    return persisted;
  }

  return manualLabelsByAddress.get(String(row?.address || '').trim()) || null;
}

function getPriorityScore(priority) {
  const normalized = String(priority || '').trim().toLowerCase();
  if (normalized === 'high') return 25;
  if (normalized === 'normal') return 15;
  if (normalized === 'low') return 5;
  return 0;
}

function isCleanupSuppressed(row) {
  const suppressedReason = String(row?.suppressed_reason || '').trim().toLowerCase();
  return suppressedReason === 'cleanup_soft_archive' || suppressedReason === 'cleanup_quarantine';
}

function computeAgeHours(row, nowMs) {
  const createdAtMs = toNumberOrNull(row?.last_token_created_at_ms);
  if (!(createdAtMs > 0) || !(nowMs > createdAtMs)) {
    return null;
  }
  return (nowMs - createdAtMs) / (60 * 60 * 1000);
}

function computeVolToMcapRatio(row) {
  const marketCap = toNumberOrNull(row?.last_mcap);
  const vol24h = toNumberOrNull(row?.last_vol_24h);
  if (!(marketCap > 0) || !(vol24h >= 0)) {
    return null;
  }
  return vol24h / marketCap;
}

function computeLiquidityToMcapRatio(row) {
  const marketCap = toNumberOrNull(row?.last_mcap);
  const liquidityUsd = toNumberOrNull(row?.last_liquidity_usd);
  if (!(marketCap > 0) || !(liquidityUsd >= 0)) {
    return null;
  }
  return liquidityUsd / marketCap;
}

function computeBuySellImbalanceRatio(row) {
  if (row?.last_txns_24h_buys == null || row?.last_txns_24h_sells == null) {
    return { total: 0, ratio: null };
  }

  const buys = toNumberOrNull(row?.last_txns_24h_buys);
  const sells = toNumberOrNull(row?.last_txns_24h_sells);

  if (!(buys >= 0) || !(sells >= 0)) {
    return { total: 0, ratio: null };
  }

  const total = buys + sells;
  const lower = Math.min(buys, sells);
  const higher = Math.max(buys, sells);

  if (higher === 0) {
    return { total, ratio: 1 };
  }
  if (lower === 0) {
    return { total, ratio: Number.POSITIVE_INFINITY };
  }

  return { total, ratio: higher / lower };
}

function shouldFlagLowLiquidity(row, options, liquidityToMcapRatio) {
  return (toNumberOrNull(row?.last_mcap) ?? 0) >= options.lowLiquidityMinMcap
    && liquidityToMcapRatio != null
    && liquidityToMcapRatio < options.lowLiquidityToMcapRatio;
}

function shouldFlagBuySellImbalance(options, buySell) {
  return buySell.total >= options.minBuySellTxns24h
    && buySell.ratio != null
    && buySell.ratio >= options.highBuySellImbalanceRatio;
}

function hasFreshSuccessfulEnrichment(row, options) {
  const enrichedAtMs = toTimestampMs(row?.last_enriched_at);
  if (!enrichedAtMs || row?.last_error) {
    return false;
  }
  return (options.nowMs - enrichedAtMs) < options.freshEnrichmentTtlMs;
}

function isRetryBackoffActive(row, options) {
  if (!row?.last_error) {
    return false;
  }

  const attemptedAtMs = toTimestampMs(row?.last_attempted_at);
  if (!attemptedAtMs) {
    return false;
  }

  return (options.nowMs - attemptedAtMs) < options.errorBackoffMs;
}

function isStructurallyStale(row, options) {
  const enrichedAtMs = toTimestampMs(row?.last_enriched_at);
  if (!enrichedAtMs) {
    return false;
  }
  return (options.nowMs - enrichedAtMs) >= options.staleEnrichmentMs;
}

function isRelevantToken(row, options) {
  const marketCap = toNumberOrNull(row?.last_mcap) || 0;
  const vol24h = toNumberOrNull(row?.last_vol_24h) || 0;
  const priority = String(row?.monitor_priority || '').trim().toLowerCase();
  return marketCap >= options.minRelevantMcap
    || vol24h >= options.minRelevantVol24h
    || priority === 'high'
    || priority === 'normal';
}

function buildSuspicionSignals(row, options) {
  const signals = [];
  const volToMcapRatio = computeVolToMcapRatio(row);
  const liquidityToMcapRatio = computeLiquidityToMcapRatio(row);
  const buySell = computeBuySellImbalanceRatio(row);
  const absPriceChange24h = Math.abs(toNumberOrNull(row?.last_price_change_24h) || 0);
  const absPriceChange6h = Math.abs(toNumberOrNull(row?.last_price_change_6h) || 0);
  const ageHours = computeAgeHours(row, options.nowMs);

  if (volToMcapRatio != null && volToMcapRatio >= options.highVolToMcapRatio) {
    signals.push('high_vol_to_mcap_ratio');
  }
  if (absPriceChange24h >= options.largePriceChange24hPct) {
    signals.push('large_price_change_24h');
  }
  if (absPriceChange6h >= options.largePriceChange6hPct) {
    signals.push('large_price_change_6h');
  }
  if (ageHours != null && ageHours <= options.newTokenAgeHours) {
    signals.push('new_token');
  }
  if (shouldFlagLowLiquidity(row, options, liquidityToMcapRatio)) {
    signals.push('low_liquidity_to_mcap');
  }
  if (shouldFlagBuySellImbalance(options, buySell)) {
    signals.push('buy_sell_imbalance_high');
  }

  return {
    ageHours,
    volToMcapRatio,
    liquidityToMcapRatio,
    buySellImbalanceRatio24h: buySell.ratio,
    txns24hTotal: buySell.total,
    signals,
  };
}

function getSkipReason(row, options) {
  const manualLabel = getManualLabel(row, options.manualLabelsByAddress);

  if (manualLabel === 'valid' || manualLabel === 'legit') {
    return { skipReason: 'manually_legit', manualLabel };
  }
  if (manualLabel === 'junk_permanent') {
    return { skipReason: 'manually_junk_permanent', manualLabel };
  }
  if (isCleanupSuppressed(row)) {
    return { skipReason: 'cleanup_suppressed', manualLabel };
  }
  if (hasFreshSuccessfulEnrichment(row, options)) {
    return { skipReason: 'fresh_enrichment_cache', manualLabel };
  }
  if (isRetryBackoffActive(row, options)) {
    return { skipReason: 'error_backoff_active', manualLabel };
  }
  if (!isRelevantToken(row, options)) {
    return { skipReason: 'low_relevance', manualLabel };
  }

  return { skipReason: null, manualLabel };
}

function buildReasonCodes(row, suspicion, options) {
  const reasonCodes = [];

  if (!row?.last_enriched_at) {
    reasonCodes.push('missing_structural_enrichment');
  } else if (isStructurallyStale(row, options)) {
    reasonCodes.push('stale_structural_enrichment');
  }

  if (row?.last_error) {
    reasonCodes.push('retry_after_enrichment_error');
  }

  for (const signal of suspicion.signals) {
    reasonCodes.push(signal);
  }

  return reasonCodes;
}

function buildCandidateScore(row, suspicion, reasonCodes) {
  let score = getPriorityScore(row?.monitor_priority);

  if (reasonCodes.includes('missing_structural_enrichment')) {
    score += 40;
  }
  if (reasonCodes.includes('stale_structural_enrichment')) {
    score += 20;
  }
  if (reasonCodes.includes('retry_after_enrichment_error')) {
    score += 15;
  }

  score += suspicion.signals.length * 8;
  return score;
}

function buildAssessment(row, options) {
  const address = String(row?.address || '').trim();
  const skipState = getSkipReason(row, options);

  if (!address) {
    return null;
  }
  if (skipState.skipReason) {
    return { address, selected: false, skipReason: skipState.skipReason };
  }

  const suspicion = buildSuspicionSignals(row, options);
  const reasonCodes = buildReasonCodes(row, suspicion, options);
  const score = buildCandidateScore(row, suspicion, reasonCodes);

  if (reasonCodes.length === 0) {
    return { address, selected: false, skipReason: 'no_enrichment_trigger' };
  }

  return {
    address,
    selected: true,
    score,
    reasonCodes,
    priority: String(row?.monitor_priority || '').trim().toLowerCase() || 'dormant',
    ageHours: suspicion.ageHours,
    volToMcapRatio: suspicion.volToMcapRatio,
    lastEnrichedAt: row?.last_enriched_at || null,
    lastAttemptedAt: row?.last_attempted_at || null,
    marketCap: toNumberOrNull(row?.last_mcap),
    volume24h: toNumberOrNull(row?.last_vol_24h),
    manualLabel: skipState.manualLabel || null,
    token: row,
  };
}

function compareSelectedCandidates(left, right) {
  return (right.score - left.score)
    || (getPriorityScore(right.priority) - getPriorityScore(left.priority))
    || ((toTimestampMs(left.lastEnrichedAt) || 0) - (toTimestampMs(right.lastEnrichedAt) || 0))
    || String(left.address).localeCompare(String(right.address));
}

function selectCandidates(rows = [], options = {}) {
  const normalized = normalizeSelectorOptions(options);
  return (Array.isArray(rows) ? rows : [])
    .map((row) => buildAssessment(row, normalized))
    .filter((row) => row?.selected)
    .sort(compareSelectedCandidates)
    .slice(0, normalized.resultLimit);
}

async function listCandidates(options = {}, deps = {}) {
  const normalized = normalizeSelectorOptions(options);
  const listCatalogCandidates = deps.listCatalogCandidates || tokenCatalog.listRiskEnrichmentCandidates;
  const rows = await listCatalogCandidates(normalized.scanLimit);
  return selectCandidates(rows, normalized);
}

module.exports = {
  listCandidates,
  selectCandidates,
  __private: {
    buildAssessment,
    buildCandidateScore,
    buildReasonCodes,
    buildSuspicionSignals,
    compareSelectedCandidates,
    computeAgeHours,
    computeVolToMcapRatio,
    getManualLabel,
    getPriorityScore,
    getSkipReason,
    hasFreshSuccessfulEnrichment,
    isCleanupSuppressed,
    isRelevantToken,
    isRetryBackoffActive,
    isStructurallyStale,
    normalizeLimit,
    normalizeManualLabelMap,
    normalizeSelectorOptions,
    toNumberOrNull,
    toTimestampMs,
  },
};
