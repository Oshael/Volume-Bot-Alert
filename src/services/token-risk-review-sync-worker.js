const tokenCatalog = require('../models/token-catalog');
const tokenMeteoraState = require('../models/token-meteora-state');
const tokenRiskReview = require('../models/token-risk-review');
const adminBlockedToken = require('../models/admin-blocked-token');
const tokenJunkEvidenceCapture = require('./token-junk-evidence-capture');
const gmgnClient = require('./gmgn-client');
const { classifyTokenJunk } = require('./token-junk-metric');

const LOOP_INTERVAL_MS = 60 * 1000;
const DEFAULT_SCAN_LIMIT = 200;
const DEFAULT_MIN_MCAP = 15000;
const GMGN_RISK_ENRICHMENT_SUPPRESSION_REASON = 'gmgn_needs_risk_enrichment';
const GMGN_CONCENTRATED_TOP_10_PCT = 90;
const GMGN_CONCENTRATED_TOP_20_PCT = 95;
const GMGN_AUTHORITY_CONCENTRATED_TOP_10_PCT = 80;
const DEX_GMGN_INFO_MAX_AGE_HOURS = 24;
const DEX_GMGN_INFO_MAX_MCAP = 500000;
const DEX_GMGN_INFO_HELIUS_HOLDER_CAP = 1000;
const DEX_GMGN_INFO_MIN_VOL_24H_TO_MCAP = 5;
const DEX_GMGN_INFO_MIN_BUY_SELL_IMBALANCE = 3;
const DEX_GMGN_INFO_MIN_PRICE_CHANGE_24H = 200;
const DEX_GMGN_INFO_MIN_HOLDERS = 10000;
const DEX_GMGN_INFO_MAX_MCAP_PER_HOLDER = 50;
const NEW_LOW_MCAP_EXTREME_VOL_MAX_AGE_HOURS = 24;
const NEW_LOW_MCAP_EXTREME_VOL_MAX_MCAP = 100000;
const NEW_LOW_MCAP_EXTREME_VOL_MIN_VOL_5M = 500000;
const NEW_LOW_MCAP_EXTREME_VOL_MIN_VOL_5M_TO_MCAP = 4;
const GMGN_LOW_MCAP_THIN_SUPPORT_MAX_MCAP = 150000;
const GMGN_LOW_MCAP_THIN_SUPPORT_MAX_LIQUIDITY_USD = 1000;
const GMGN_LOW_MCAP_THIN_SUPPORT_MAX_LIQUIDITY_TO_MCAP = 0.01;
const GMGN_LOW_MCAP_THIN_SUPPORT_MAX_RECENT_VOLUME = 100;
const GMGN_LOW_MCAP_EXTREME_24H_CHURN_MAX_MCAP = 100000;
const GMGN_LOW_MCAP_EXTREME_24H_CHURN_MIN_VOL_24H_TO_MCAP = 20;
const GMGN_LOW_MCAP_EXTREME_24H_CHURN_MIN_TXNS_24H = 1000;
const GMGN_YOUNG_LOW_CAP_HIGH_CHURN_MAX_AGE_HOURS = 6;
const GMGN_YOUNG_LOW_CAP_HIGH_CHURN_MAX_MCAP = 100000;
const GMGN_YOUNG_LOW_CAP_HIGH_CHURN_MAX_LIQUIDITY_USD = 100;
const GMGN_YOUNG_LOW_CAP_HIGH_CHURN_MAX_LIQUIDITY_TO_MCAP = 0.002;
const GMGN_YOUNG_LOW_CAP_HIGH_CHURN_MIN_VOL_1H_TO_MCAP = 2;
const GMGN_YOUNG_LOW_CAP_HIGH_CHURN_MIN_TXNS_24H = 1000;
const GMGN_YOUNG_LOW_CAP_HIGH_CHURN_MIN_PRICE_CHANGE_24H = 200;

let timer = null;
let running = false;
let activeRunPromise = null;
let nextOffset = 0;
let status = {
  running: false,
  inFlight: false,
  lastRunAt: null,
  lastCompletedAt: null,
  lastRunDurationMs: 0,
  lastScheduledDelayMs: LOOP_INTERVAL_MS,
  lastScanLimit: DEFAULT_SCAN_LIMIT,
  lastMinMcap: DEFAULT_MIN_MCAP,
  lastOffset: 0,
  nextOffset,
  lastCandidateCount: 0,
  lastProcessed: 0,
  lastSaved: 0,
  lastAutoBlocked: 0,
  lastManualProtected: 0,
  lastReleased: 0,
  totalProcessed: 0,
  totalSaved: 0,
  totalAutoBlocked: 0,
  totalManualProtected: 0,
  totalReleased: 0,
  totalErrors: 0,
  lastError: null,
};

function normalizeLimit(value, fallback, max = 5000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.trunc(parsed), max));
}

function normalizeOptions(options = {}) {
  return {
    scanLimit: normalizeLimit(options.scanLimit, DEFAULT_SCAN_LIMIT),
    minMcap: Math.max(0, Number(options.minMcap) || DEFAULT_MIN_MCAP),
  };
}

function normalizeDelayMs(value, fallback = LOOP_INTERVAL_MS) {
  const delayMs = Number(value);
  if (!Number.isFinite(delayMs)) {
    return fallback;
  }
  return Math.max(0, Math.round(delayMs));
}

function computeNextDelayMs(runDurationMs) {
  return normalizeDelayMs(LOOP_INTERVAL_MS - normalizeDelayMs(runDurationMs));
}

function buildMeteoraMetric(summaryRow) {
  const hasPool = summaryRow?.hasPool === true && (Number(summaryRow?.currentTvl) || 0) > 0;
  return {
    noPool: !hasPool,
    poolCount: hasPool ? (Number(summaryRow?.poolCount) || 0) : 0,
    tvl: hasPool ? (Number(summaryRow?.currentTvl) || 0) : null,
  };
}

function normalizeAutoLabel(assessment) {
  const label = String(assessment?.label || '').trim().toLowerCase();
  if (!label) {
    return null;
  }
  return label === 'junk_permanent' ? 'junk_probable' : label;
}

function hasStructuralCoverage(row) {
  return Boolean(
    row?.risk_enrichment_last_enriched_at
    || row?.risk_holder_count != null
    || row?.risk_top_10_pct != null
    || row?.risk_top_20_pct != null
    || row?.risk_mint_authority_active
    || row?.risk_freeze_authority_active
  );
}

function toFiniteNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function calculateAgeHoursFromMs(timestampMs) {
  const createdAtMs = toFiniteNumberOrNull(timestampMs);
  if (!(createdAtMs > 0)) {
    return null;
  }

  const nowMs = Date.now();
  if (!(nowMs > createdAtMs)) {
    return null;
  }

  return (nowMs - createdAtMs) / (60 * 60 * 1000);
}

function computeRatio(numerator, denominator) {
  const parsedNumerator = toFiniteNumberOrNull(numerator);
  const parsedDenominator = toFiniteNumberOrNull(denominator);
  if (!(parsedDenominator > 0) || !(parsedNumerator >= 0)) {
    return null;
  }
  return parsedNumerator / parsedDenominator;
}

function isGmgnSource(row) {
  return String(row?.source || '').trim().toLowerCase() === 'gmgn';
}

function isManualReviewProtected(row = {}) {
  return String(row?.risk_review_source || '').trim().toLowerCase() === 'manual';
}

function hasGmgnThinLiquidity(row = {}) {
  const marketCap = toFiniteNumberOrNull(row.last_mcap);
  const liquidityUsd = toFiniteNumberOrNull(row.last_liquidity_usd);
  const liquidityToMcap = computeRatio(liquidityUsd, marketCap);

  return liquidityUsd != null
    && (
      liquidityUsd <= GMGN_LOW_MCAP_THIN_SUPPORT_MAX_LIQUIDITY_USD
      || (liquidityToMcap != null && liquidityToMcap <= GMGN_LOW_MCAP_THIN_SUPPORT_MAX_LIQUIDITY_TO_MCAP)
    );
}

function hasGmgnDeadRecentVolume(row = {}) {
  const vol1h = toFiniteNumberOrNull(row.last_vol_1h);
  const vol6h = toFiniteNumberOrNull(row.last_vol_6h);
  return (vol1h ?? 0) <= GMGN_LOW_MCAP_THIN_SUPPORT_MAX_RECENT_VOLUME
    && (vol6h ?? 0) <= GMGN_LOW_MCAP_THIN_SUPPORT_MAX_RECENT_VOLUME;
}

function hasNoMeteoraPool(summaryRow) {
  if (!summaryRow) {
    return true;
  }
  return summaryRow.hasPool !== true || !((Number(summaryRow.currentTvl) || 0) > 0);
}

function isDexGmgnHolderAnomalySourceEligible(row = {}) {
  const source = String(row?.source || '').trim().toLowerCase();
  if (isGmgnSource(row) || source === 'user-manual') {
    return false;
  }
  return String(row?.risk_review_source || '').trim().toLowerCase() !== 'manual';
}

function hasDexGmgnHolderAnomalyBaseProfile(row = {}) {
  const ageHours = calculateAgeHoursFromMs(row.last_token_created_at_ms);
  const marketCap = toFiniteNumberOrNull(row.last_mcap);
  const heliusHolderCount = toFiniteNumberOrNull(row.risk_holder_count);
  if (ageHours == null || ageHours >= DEX_GMGN_INFO_MAX_AGE_HOURS) {
    return false;
  }
  if (!(marketCap > 0) || marketCap > DEX_GMGN_INFO_MAX_MCAP) {
    return false;
  }
  if (heliusHolderCount == null || heliusHolderCount < DEX_GMGN_INFO_HELIUS_HOLDER_CAP) {
    return false;
  }
  return true;
}

function hasDexGmgnHolderAnomalyTrigger(row = {}) {
  const marketCap = toFiniteNumberOrNull(row.last_mcap);
  const vol24hToMcap = computeRatio(row.last_vol_24h, marketCap);
  const buySellImbalance = computeRatio(row.last_txns_24h_buys, row.last_txns_24h_sells);
  const priceChange24h = Math.abs(toFiniteNumberOrNull(row.last_price_change_24h) || 0);
  return (vol24hToMcap != null && vol24hToMcap >= DEX_GMGN_INFO_MIN_VOL_24H_TO_MCAP)
    || (buySellImbalance != null && buySellImbalance >= DEX_GMGN_INFO_MIN_BUY_SELL_IMBALANCE)
    || priceChange24h >= DEX_GMGN_INFO_MIN_PRICE_CHANGE_24H;
}

function shouldCheckDexGmgnHolderAnomaly(row = {}) {
  return isDexGmgnHolderAnomalySourceEligible(row)
    && hasDexGmgnHolderAnomalyBaseProfile(row)
    && hasDexGmgnHolderAnomalyTrigger(row);
}

function buildNewLowMcapExtremeVolumeAssessment(row = {}) {
  const ageHours = calculateAgeHoursFromMs(row.last_token_created_at_ms);
  const marketCap = toFiniteNumberOrNull(row.last_mcap);
  const vol5m = toFiniteNumberOrNull(row.last_vol_5m);
  const vol5mToMcap = computeRatio(vol5m, marketCap);
  if (
    ageHours == null
    || ageHours >= NEW_LOW_MCAP_EXTREME_VOL_MAX_AGE_HOURS
    || marketCap == null
    || marketCap > NEW_LOW_MCAP_EXTREME_VOL_MAX_MCAP
    || vol5m == null
    || vol5m < NEW_LOW_MCAP_EXTREME_VOL_MIN_VOL_5M
    || vol5mToMcap == null
    || vol5mToMcap < NEW_LOW_MCAP_EXTREME_VOL_MIN_VOL_5M_TO_MCAP
  ) {
    return null;
  }

  return {
    label: 'junk_probable',
    confidence: 'high',
    manualReviewRequired: true,
    autoBlock: false,
    mode: 'low_mcap_extreme_volume_gate',
    strongSignalCount: 1,
    reasonCodes: ['new_low_mcap_extreme_vol5m_churn'],
    strongSignals: ['new_low_mcap_extreme_vol5m_churn'],
    weakSignals: [],
    behavioralSignals: [],
    positiveSignals: [],
    marketCap,
    volume5m: vol5m,
    vol5mToMcapRatio: vol5mToMcap,
  };
}

function buildGmgnLowMcapThinSupportAssessment(row = {}, meteoraSummary = null) {
  const marketCap = toFiniteNumberOrNull(row.last_mcap);
  if (
    !isGmgnSource(row)
    || isManualReviewProtected(row)
    || !(marketCap >= DEFAULT_MIN_MCAP)
    || marketCap > GMGN_LOW_MCAP_THIN_SUPPORT_MAX_MCAP
    || !hasGmgnThinLiquidity(row)
    || !hasGmgnDeadRecentVolume(row)
    || !hasNoMeteoraPool(meteoraSummary)
  ) {
    return null;
  }

  return {
    label: 'junk_probable',
    confidence: 'high',
    manualReviewRequired: true,
    autoBlock: false,
    mode: 'gmgn_low_mcap_thin_support_gate',
    strongSignalCount: 1,
    reasonCodes: ['gmgn_low_mcap_thin_support'],
    strongSignals: ['gmgn_low_mcap_thin_support'],
    weakSignals: [],
    behavioralSignals: [],
    positiveSignals: [],
    marketCap,
    liquidityUsd: toFiniteNumberOrNull(row.last_liquidity_usd),
    volume1h: toFiniteNumberOrNull(row.last_vol_1h),
    volume6h: toFiniteNumberOrNull(row.last_vol_6h),
  };
}

function buildGmgnLowMcapExtreme24hChurnAssessment(row = {}) {
  const marketCap = toFiniteNumberOrNull(row.last_mcap);
  const vol24h = toFiniteNumberOrNull(row.last_vol_24h);
  const vol24hToMcap = computeRatio(vol24h, marketCap);
  const txns24h = (toFiniteNumberOrNull(row.last_txns_24h_buys) || 0)
    + (toFiniteNumberOrNull(row.last_txns_24h_sells) || 0);

  if (
    !isGmgnSource(row)
    || isManualReviewProtected(row)
    || !(marketCap >= DEFAULT_MIN_MCAP)
    || marketCap > GMGN_LOW_MCAP_EXTREME_24H_CHURN_MAX_MCAP
    || vol24hToMcap == null
    || vol24hToMcap < GMGN_LOW_MCAP_EXTREME_24H_CHURN_MIN_VOL_24H_TO_MCAP
    || txns24h < GMGN_LOW_MCAP_EXTREME_24H_CHURN_MIN_TXNS_24H
    || !hasGmgnThinLiquidity(row)
  ) {
    return null;
  }

  return {
    label: 'junk_probable',
    confidence: 'high',
    manualReviewRequired: true,
    autoBlock: false,
    mode: 'gmgn_low_mcap_extreme_24h_churn_gate',
    strongSignalCount: 1,
    reasonCodes: ['gmgn_low_mcap_extreme_24h_churn_thin_liquidity'],
    strongSignals: ['gmgn_low_mcap_extreme_24h_churn_thin_liquidity'],
    weakSignals: [],
    behavioralSignals: [],
    positiveSignals: [],
    marketCap,
    volume24h: vol24h,
    vol24hToMcapRatio: vol24hToMcap,
    txns24hTotal: txns24h,
    liquidityUsd: toFiniteNumberOrNull(row.last_liquidity_usd),
  };
}

function hasYoungLowCapHighChurnBaseProfile(row = {}) {
  const ageHours = calculateAgeHoursFromMs(row.last_token_created_at_ms);
  const marketCap = toFiniteNumberOrNull(row.last_mcap);
  return isGmgnSource(row)
    && !isManualReviewProtected(row)
    && ageHours != null
    && ageHours < GMGN_YOUNG_LOW_CAP_HIGH_CHURN_MAX_AGE_HOURS
    && marketCap >= DEFAULT_MIN_MCAP
    && marketCap <= GMGN_YOUNG_LOW_CAP_HIGH_CHURN_MAX_MCAP;
}

function hasYoungLowCapThinLiquidity(row = {}) {
  const marketCap = toFiniteNumberOrNull(row.last_mcap);
  const liquidityUsd = toFiniteNumberOrNull(row.last_liquidity_usd);
  const liquidityToMcap = computeRatio(liquidityUsd, marketCap);
  return liquidityUsd != null
    && (
      liquidityUsd <= GMGN_YOUNG_LOW_CAP_HIGH_CHURN_MAX_LIQUIDITY_USD
      || (liquidityToMcap != null && liquidityToMcap <= GMGN_YOUNG_LOW_CAP_HIGH_CHURN_MAX_LIQUIDITY_TO_MCAP)
    );
}

function hasYoungLowCapHighChurnMarket(row = {}) {
  const marketCap = toFiniteNumberOrNull(row.last_mcap);
  const vol1hToMcap = computeRatio(row.last_vol_1h, marketCap);
  const priceChange24h = Math.abs(toFiniteNumberOrNull(row.last_price_change_24h) || 0);
  const txns24h = (toFiniteNumberOrNull(row.last_txns_24h_buys) || 0)
    + (toFiniteNumberOrNull(row.last_txns_24h_sells) || 0);

  return vol1hToMcap != null
    && vol1hToMcap >= GMGN_YOUNG_LOW_CAP_HIGH_CHURN_MIN_VOL_1H_TO_MCAP
    && txns24h >= GMGN_YOUNG_LOW_CAP_HIGH_CHURN_MIN_TXNS_24H
    && priceChange24h >= GMGN_YOUNG_LOW_CAP_HIGH_CHURN_MIN_PRICE_CHANGE_24H;
}

function buildGmgnYoungLowCapHighChurnAssessment(row = {}, meteoraSummary = null) {
  const marketCap = toFiniteNumberOrNull(row.last_mcap);
  const liquidityUsd = toFiniteNumberOrNull(row.last_liquidity_usd);
  const liquidityToMcap = computeRatio(liquidityUsd, marketCap);
  const vol1h = toFiniteNumberOrNull(row.last_vol_1h);
  const vol1hToMcap = computeRatio(vol1h, marketCap);
  const ageHours = calculateAgeHoursFromMs(row.last_token_created_at_ms);
  const priceChange24h = Math.abs(toFiniteNumberOrNull(row.last_price_change_24h) || 0);
  const txns24h = (toFiniteNumberOrNull(row.last_txns_24h_buys) || 0)
    + (toFiniteNumberOrNull(row.last_txns_24h_sells) || 0);

  if (
    !hasYoungLowCapHighChurnBaseProfile(row)
    || !hasYoungLowCapThinLiquidity(row)
    || !hasYoungLowCapHighChurnMarket(row)
    || !hasNoMeteoraPool(meteoraSummary)
  ) {
    return null;
  }

  return {
    label: 'valid_but_weak',
    confidence: 'medium',
    manualReviewRequired: true,
    autoBlock: false,
    mode: 'gmgn_young_low_cap_high_churn_gate',
    strongSignalCount: 0,
    reasonCodes: ['gmgn_young_low_cap_high_churn_thin_liquidity'],
    strongSignals: [],
    weakSignals: ['gmgn_young_low_cap_high_churn_thin_liquidity'],
    behavioralSignals: ['gmgn_young_low_cap_high_churn_thin_liquidity'],
    positiveSignals: [],
    marketCap,
    ageHours,
    volume1h: vol1h,
    vol1hToMcapRatio: vol1hToMcap,
    txns24hTotal: txns24h,
    priceChange24h,
    liquidityUsd,
    liquidityToMcapRatio: liquidityToMcap,
  };
}

function buildDexGmgnHolderAnomalyAssessment(row = {}, info = {}) {
  const gmgnHolderCount = toFiniteNumberOrNull(info.holderCount);
  const gmgnMarketCap = toFiniteNumberOrNull(info.marketCap) ?? toFiniteNumberOrNull(row.last_mcap);
  const mcapPerHolder = computeRatio(gmgnMarketCap, gmgnHolderCount);
  if (
    gmgnHolderCount == null
    || gmgnHolderCount < DEX_GMGN_INFO_MIN_HOLDERS
    || mcapPerHolder == null
    || mcapPerHolder > DEX_GMGN_INFO_MAX_MCAP_PER_HOLDER
  ) {
    return null;
  }

  return {
    label: 'junk_probable',
    confidence: 'high',
    manualReviewRequired: true,
    autoBlock: false,
    mode: 'gmgn_info_holder_anomaly',
    strongSignalCount: 1,
    reasonCodes: ['gmgn_holder_count_mcap_anomaly'],
    strongSignals: ['gmgn_holder_count_mcap_anomaly'],
    weakSignals: [],
    behavioralSignals: [],
    positiveSignals: [],
    marketCap: gmgnMarketCap,
    holderCount: gmgnHolderCount,
    mcapPerHolder,
  };
}

async function assessDexGmgnHolderAnomaly(row = {}, deps = {}) {
  if (!shouldCheckDexGmgnHolderAnomaly(row)) {
    return null;
  }

  const client = deps.gmgnClient || gmgnClient.createGmgnClient(deps.gmgnClientOptions || {});
  try {
    const info = await client.fetchTokenInfo({
      chain: 'sol',
      address: row.address,
    });
    return buildDexGmgnHolderAnomalyAssessment(row, info || {});
  } catch (error) {
    console.error(`[TokenRiskReviewSyncWorker] GMGN info anomaly check failed for ${row?.address || 'unknown'}:`, error.message);
    return null;
  }
}

function isGmgnRiskEnrichmentSuppressed(row) {
  return String(row?.source || '').trim().toLowerCase() === 'gmgn'
    && String(row?.suppressed_reason || '').trim() === GMGN_RISK_ENRICHMENT_SUPPRESSION_REASON;
}

function hasGmgnConcentratedStructure(row) {
  const top10Pct = toFiniteNumberOrNull(row?.risk_top_10_pct);
  const top20Pct = toFiniteNumberOrNull(row?.risk_top_20_pct);
  const authorityActive = row?.risk_mint_authority_active === true || row?.risk_freeze_authority_active === true;

  return (top20Pct != null && top20Pct >= GMGN_CONCENTRATED_TOP_20_PCT)
    || (top10Pct != null && top10Pct >= GMGN_CONCENTRATED_TOP_10_PCT)
    || (authorityActive && top10Pct != null && top10Pct >= GMGN_AUTHORITY_CONCENTRATED_TOP_10_PCT);
}

function buildGmgnRiskGateAssessment(row) {
  if (!isGmgnRiskEnrichmentSuppressed(row) || !hasStructuralCoverage(row)) {
    return null;
  }

  const reasonCodes = hasGmgnConcentratedStructure(row)
    ? ['gmgn_young_extreme_churn', 'gmgn_concentrated_structure']
    : [];

  return {
    label: reasonCodes.length ? 'junk_probable' : 'valid',
    confidence: reasonCodes.length ? 'high' : 'medium',
    manualReviewRequired: reasonCodes.length > 0,
    autoBlock: false,
    mode: 'gmgn_risk_enrichment_gate',
    strongSignalCount: reasonCodes.length ? 1 : 0,
    reasonCodes,
    strongSignals: reasonCodes,
    weakSignals: [],
    behavioralSignals: [],
    positiveSignals: reasonCodes.length ? [] : ['gmgn_structural_enrichment_passed'],
    marketCap: toFiniteNumberOrNull(row?.last_mcap),
    holderCount: toFiniteNumberOrNull(row?.risk_holder_count),
    top10Pct: toFiniteNumberOrNull(row?.risk_top_10_pct),
    top20Pct: toFiniteNumberOrNull(row?.risk_top_20_pct),
    liquidityUsd: toFiniteNumberOrNull(row?.last_liquidity_usd),
  };
}

function normalizePersistedAutoLabel(row, assessment) {
  const label = normalizeAutoLabel(assessment);
  if (!label) {
    return null;
  }

  if (label === 'valid' && !hasStructuralCoverage(row)) {
    return 'valid_but_weak';
  }

  return label;
}

function buildAutoNotes(assessment) {
  const mode = String(assessment?.mode || 'auto').trim() || 'auto';
  const reasonCodes = Array.isArray(assessment?.reasonCodes)
    ? assessment.reasonCodes.map((item) => String(item || '').trim()).filter(Boolean)
    : [];

  if (!reasonCodes.length) {
    return `auto/${mode}`;
  }

  return `auto/${mode}: ${reasonCodes.join(', ')}`;
}

async function captureEvidenceSafely(row, assessment, meteoraSummary, deps = {}) {
  const evidenceCaptureService = deps.tokenJunkEvidenceCaptureService || tokenJunkEvidenceCapture;
  try {
    await evidenceCaptureService.captureJunkEvidence(row, assessment, meteoraSummary, deps);
  } catch (err) {
    console.error(`[TokenRiskReviewSyncWorker] Failed to capture junk evidence for ${row?.address || 'unknown'}:`, err.message);
  }
}

function shouldAutoBlockLabel(label) {
  return String(label || '').trim().toLowerCase() === 'junk_probable';
}

function buildAutoBlockLabel(assessment) {
  const reasonCodes = Array.isArray(assessment?.reasonCodes)
    ? assessment.reasonCodes.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const suffix = reasonCodes.slice(0, 3).join(',');
  return suffix ? `auto-junk-probable:${suffix}` : 'auto-junk-probable';
}

function resolveGmgnEligibilityState(marketCap) {
  if (marketCap >= 100000) return 'gmgn-high';
  if (marketCap >= 30000) return 'gmgn-normal';
  return 'gmgn-low';
}

function resolveGmgnMonitorPriority(marketCap) {
  if (marketCap >= 100000) return 'high';
  if (marketCap >= 30000) return 'normal';
  return 'low';
}

function buildGmgnRiskReleasePayload(row = {}) {
  const marketCap = toFiniteNumberOrNull(row.last_mcap) || 0;
  return {
    eligibilityState: resolveGmgnEligibilityState(marketCap),
    eligibleForMonitoring: true,
    suppressedReason: null,
    nextEvaluationAt: new Date(Date.now() + 30000),
    monitorPriority: resolveGmgnMonitorPriority(marketCap),
    symbol: row.symbol || null,
    name: row.name || null,
    mcap: row.last_mcap,
    price: row.last_price,
    vol5m: row.last_vol_5m,
    vol1h: row.last_vol_1h,
    vol6h: row.last_vol_6h,
    vol24h: row.last_vol_24h,
    priceChange1h: row.last_price_change_1h,
    priceChange6h: row.last_price_change_6h,
    priceChange24h: row.last_price_change_24h,
    liquidityUsd: row.last_liquidity_usd,
    txns1hBuys: row.last_txns_1h_buys,
    txns1hSells: row.last_txns_1h_sells,
    txns24hBuys: row.last_txns_24h_buys,
    txns24hSells: row.last_txns_24h_sells,
    tokenCreatedAt: row.last_token_created_at_ms,
  };
}

async function releaseGmgnRiskSuppression(row, deps = {}) {
  if (!isGmgnRiskEnrichmentSuppressed(row)) {
    return false;
  }

  const catalogModel = deps.tokenCatalogModel || tokenCatalog;
  await catalogModel.applyEvaluationResult(row.address, buildGmgnRiskReleasePayload(row));
  return true;
}

async function autoBlockToken(row, assessment, deps = {}) {
  const address = String(row?.address || '').trim();
  if (!address) {
    return false;
  }

  const blockedTokenModel = deps.adminBlockedTokenModel || adminBlockedToken;
  const catalogModel = deps.tokenCatalogModel || tokenCatalog;
  const reviewModel = deps.tokenRiskReviewModel || tokenRiskReview;

  await blockedTokenModel.add({
    address,
    label: buildAutoBlockLabel(assessment),
    createdBy: null,
  });

  await catalogModel.applyEvaluationResult(address, {
    eligibilityState: 'admin-blocked',
    eligibleForMonitoring: false,
    suppressedReason: 'admin_blocked',
    nextEvaluationAt: new Date(Date.now() + (10 * 365 * 24 * 60 * 60 * 1000)),
    monitorPriority: 'dormant',
    symbol: row?.symbol || null,
    name: row?.name || null,
  });

  await reviewModel.removeAutoReview(address);
  return true;
}

async function listCandidates(offset, options, deps = {}) {
  const catalogModel = deps.tokenCatalogModel || tokenCatalog;
  const rows = await catalogModel.listAutoRiskReviewCandidates(options.scanLimit, offset, options.minMcap);
  if (rows.length === 0 && offset > 0) {
    nextOffset = 0;
    return catalogModel.listAutoRiskReviewCandidates(options.scanLimit, 0, options.minMcap);
  }
  return rows;
}

async function assessRiskReviewRow(row, meteoraSummary, deps = {}) {
  return buildGmgnRiskGateAssessment(row)
    || buildNewLowMcapExtremeVolumeAssessment(row)
    || buildGmgnLowMcapExtreme24hChurnAssessment(row)
    || buildGmgnYoungLowCapHighChurnAssessment(row, meteoraSummary)
    || buildGmgnLowMcapThinSupportAssessment(row, meteoraSummary)
    || await assessDexGmgnHolderAnomaly(row, deps)
    || classifyTokenJunk({
      ...row,
      meteora: buildMeteoraMetric(meteoraSummary),
    });
}

async function processRows(rows = [], deps = {}) {
  const meteoraModel = deps.tokenMeteoraStateModel || tokenMeteoraState;
  const reviewModel = deps.tokenRiskReviewModel || tokenRiskReview;
  const addresses = rows.map((row) => row.address).filter(Boolean);
  const meteoraRows = await meteoraModel.listSummaryByAddresses(addresses);
  const meteoraByAddress = new Map(meteoraRows.map((row) => [String(row.tokenAddress || row.token_address), row]));

  let saved = 0;
  let autoBlocked = 0;
  let manualProtected = 0;
  let released = 0;

  for (const row of rows) {
    const meteoraSummary = meteoraByAddress.get(row.address) || null;
    const assessment = await assessRiskReviewRow(row, meteoraSummary, deps);

    const label = normalizePersistedAutoLabel(row, assessment);
    if (!label) {
      continue;
    }

    await captureEvidenceSafely(row, assessment, meteoraSummary, deps);

    const review = await reviewModel.upsertAutoReview({
      tokenAddress: row.address,
      label,
      notes: buildAutoNotes(assessment),
    });

    if (review?.source === 'manual') {
      manualProtected += 1;
      continue;
    }

    if (shouldAutoBlockLabel(label) && await autoBlockToken(row, assessment, deps)) {
      autoBlocked += 1;
    } else if (label === 'valid' && await releaseGmgnRiskSuppression(row, deps)) {
      released += 1;
    }

    saved += 1;
  }

  return { saved, autoBlocked, manualProtected, released };
}

function schedule(options = {}) {
  if (!running) return;
  timer = setTimeout(async () => {
    try {
      await runOnce(options, { ifRunning: 'join' });
    } catch (err) {
      console.error('[TokenRiskReviewSyncWorker] Scheduled run failed:', err.message);
    } finally {
      schedule(options);
    }
  }, LOOP_INTERVAL_MS);
}

async function runOnce(options = {}, meta = {}, deps = {}) {
  const normalizedOptions = normalizeOptions(options);
  const ifRunning = String(meta.ifRunning || 'reject').trim().toLowerCase();

  if (activeRunPromise) {
    if (ifRunning === 'join') {
      return activeRunPromise;
    }
    throw new Error('Token risk review sync worker already has an active run');
  }

  activeRunPromise = (async () => {
    const startedAtMs = Date.now();
    const offset = nextOffset;

    status.inFlight = true;
    status.lastRunAt = new Date(startedAtMs).toISOString();
    status.lastScanLimit = normalizedOptions.scanLimit;
    status.lastMinMcap = normalizedOptions.minMcap;
    status.lastOffset = offset;
    status.lastProcessed = 0;
    status.lastSaved = 0;
    status.lastAutoBlocked = 0;
    status.lastManualProtected = 0;
    status.lastReleased = 0;
    status.lastError = null;

    try {
      const rows = await listCandidates(offset, normalizedOptions, deps);
      const result = await processRows(rows, deps);

      nextOffset = rows.length < normalizedOptions.scanLimit
        ? 0
        : offset + rows.length;

      status.nextOffset = nextOffset;
      status.lastCandidateCount = rows.length;
      status.lastProcessed = rows.length;
      status.lastSaved = result.saved;
      status.lastAutoBlocked = result.autoBlocked;
      status.lastManualProtected = result.manualProtected;
      status.lastReleased = result.released;
      status.totalProcessed += rows.length;
      status.totalSaved += result.saved;
      status.totalAutoBlocked += result.autoBlocked;
      status.totalManualProtected += result.manualProtected;
      status.totalReleased += result.released;
      status.lastCompletedAt = new Date().toISOString();
      status.lastRunDurationMs = Date.now() - startedAtMs;
      status.lastScheduledDelayMs = computeNextDelayMs(status.lastRunDurationMs);

      return {
        startedAt: status.lastRunAt,
        completedAt: status.lastCompletedAt,
        candidateCount: rows.length,
        processed: rows.length,
        saved: result.saved,
        autoBlocked: result.autoBlocked,
        manualProtected: result.manualProtected,
        released: result.released,
        nextOffset,
      };
    } catch (error) {
      status.totalErrors += 1;
      status.lastError = String(error?.message || error || 'Unknown worker error');
      throw error;
    } finally {
      status.inFlight = false;
      activeRunPromise = null;
    }
  })();

  return activeRunPromise;
}

function start(options = {}) {
  if (running) return;
  running = true;
  status.running = true;
  nextOffset = 0;
  status.nextOffset = nextOffset;
  schedule(options);
}

function stop() {
  running = false;
  status.running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function getStatus() {
  return {
    ...status,
    nextOffset,
  };
}

module.exports = {
  LOOP_INTERVAL_MS,
  DEFAULT_SCAN_LIMIT,
  DEFAULT_MIN_MCAP,
  getStatus,
  runOnce,
  start,
  stop,
  __private: {
    buildAutoNotes,
    assessRiskReviewRow,
    autoBlockToken,
    buildGmgnLowMcapExtreme24hChurnAssessment,
    buildGmgnLowMcapThinSupportAssessment,
    buildGmgnYoungLowCapHighChurnAssessment,
    buildGmgnRiskGateAssessment,
    buildGmgnRiskReleasePayload,
    captureEvidenceSafely,
    buildMeteoraMetric,
    buildAutoBlockLabel,
    hasGmgnConcentratedStructure,
    hasStructuralCoverage,
    isGmgnRiskEnrichmentSuppressed,
    listCandidates,
    normalizeAutoLabel,
    normalizePersistedAutoLabel,
    normalizeOptions,
    processRows,
    releaseGmgnRiskSuppression,
    shouldAutoBlockLabel,
  },
};
