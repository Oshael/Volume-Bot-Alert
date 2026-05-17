const tokenCatalog = require('../models/token-catalog');
const tokenMeteoraState = require('../models/token-meteora-state');
const tokenRiskReview = require('../models/token-risk-review');
const adminBlockedToken = require('../models/admin-blocked-token');
const tokenMarketBucket1m = require('../models/token-market-bucket-1m');
const tokenJunkEvidenceCapture = require('./token-junk-evidence-capture');
const gmgnClient = require('./gmgn-client');
const { classifyTokenJunk } = require('./token-junk-metric');
const {
  AUTO_BLOCK_LABEL_PREFIXES,
  AUTO_BLOCK_REASON_CODES,
  buildCommaSuffixAutoBlockLabel,
} = require('./auto-block-rule-labels');

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
const GLOBAL_LOW_LIQUIDITY_AUTO_BLOCK_MAX_USD = 1000;
const GLOBAL_LOW_LIQUIDITY_CONFIRMATION_BUCKETS = 5;
const GLOBAL_LOW_LIQUIDITY_MAX_AGE_HOURS = 6;
const GMGN_LOW_MCAP_THIN_SUPPORT_MAX_MCAP = 150000;
const GMGN_LOW_MCAP_THIN_SUPPORT_MAX_LIQUIDITY_USD = 1000;
const GMGN_LOW_MCAP_THIN_SUPPORT_MAX_LIQUIDITY_TO_MCAP = 0.01;
const GMGN_LOW_MCAP_THIN_SUPPORT_MAX_RECENT_VOLUME = 100;
const GMGN_CONFIRMED_MICRO_LIQUIDITY_MAX_USD = 100;
const GMGN_CONFIRMED_MICRO_LIQUIDITY_MAX_TO_MCAP = 0.002;
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
    reasonCodes: [AUTO_BLOCK_REASON_CODES.NEW_LOW_MCAP_EXTREME_VOL5M_CHURN],
    strongSignals: [AUTO_BLOCK_REASON_CODES.NEW_LOW_MCAP_EXTREME_VOL5M_CHURN],
    weakSignals: [],
    behavioralSignals: [],
    positiveSignals: [],
    marketCap,
    volume5m: vol5m,
    vol5mToMcapRatio: vol5mToMcap,
  };
}

function hasConfirmedLowLiquiditySamples(samples = []) {
  if (!Array.isArray(samples) || samples.length < GLOBAL_LOW_LIQUIDITY_CONFIRMATION_BUCKETS) {
    return false;
  }

  return samples
    .slice(0, GLOBAL_LOW_LIQUIDITY_CONFIRMATION_BUCKETS)
    .every((sample) => {
      const liquidityUsd = toFiniteNumberOrNull(sample?.close_liquidity_usd ?? sample?.closeLiquidityUsd);
      return liquidityUsd != null && liquidityUsd < GLOBAL_LOW_LIQUIDITY_AUTO_BLOCK_MAX_USD;
    });
}

function isGlobalLowLiquidityAgeEligible(row = {}) {
  const ageHours = calculateAgeHoursFromMs(row.last_token_created_at_ms);
  return ageHours != null && ageHours <= GLOBAL_LOW_LIQUIDITY_MAX_AGE_HOURS;
}

function needsLowLiquidityConfirmation(row = {}) {
  const liquidityUsd = toFiniteNumberOrNull(row.last_liquidity_usd);
  return liquidityUsd != null
    && liquidityUsd < GLOBAL_LOW_LIQUIDITY_AUTO_BLOCK_MAX_USD
    && isGlobalLowLiquidityAgeEligible(row);
}

function hasRequiredLowLiquidityConfirmation(row = {}, samples = []) {
  return !needsLowLiquidityConfirmation(row) || hasConfirmedLowLiquiditySamples(samples);
}

function buildGlobalLowLiquidityAssessment(row = {}, liquiditySamples = []) {
  const liquidityUsd = toFiniteNumberOrNull(row.last_liquidity_usd);
  const ageHours = calculateAgeHoursFromMs(row.last_token_created_at_ms);
  if (
    isManualReviewProtected(row)
    || liquidityUsd == null
    || liquidityUsd >= GLOBAL_LOW_LIQUIDITY_AUTO_BLOCK_MAX_USD
    || ageHours == null
    || ageHours > GLOBAL_LOW_LIQUIDITY_MAX_AGE_HOURS
    || !hasConfirmedLowLiquiditySamples(liquiditySamples)
  ) {
    return null;
  }

  const marketCap = toFiniteNumberOrNull(row.last_mcap);
  return {
    label: 'junk_probable',
    confidence: 'high',
    manualReviewRequired: true,
    autoBlock: false,
    mode: 'global_low_liquidity_gate',
    strongSignalCount: 1,
    reasonCodes: [AUTO_BLOCK_REASON_CODES.LOW_LIQUIDITY_UNDER_1K],
    strongSignals: [AUTO_BLOCK_REASON_CODES.LOW_LIQUIDITY_UNDER_1K],
    weakSignals: [],
    behavioralSignals: [],
    positiveSignals: [],
    marketCap,
    liquidityUsd,
    ageHours,
    confirmationBuckets: GLOBAL_LOW_LIQUIDITY_CONFIRMATION_BUCKETS,
    maxAgeHours: GLOBAL_LOW_LIQUIDITY_MAX_AGE_HOURS,
    liquidityToMcapRatio: computeRatio(liquidityUsd, marketCap),
  };
}

function buildLowLiquidityPendingConfirmationAssessment(row = {}, liquiditySamples = []) {
  const liquidityUsd = toFiniteNumberOrNull(row.last_liquidity_usd);
  if (!needsLowLiquidityConfirmation(row) || hasConfirmedLowLiquiditySamples(liquiditySamples)) {
    return null;
  }

  const marketCap = toFiniteNumberOrNull(row.last_mcap);
  return {
    label: 'valid',
    confidence: 'low',
    manualReviewRequired: false,
    autoBlock: false,
    mode: 'low_liquidity_pending_confirmation',
    strongSignalCount: 0,
    reasonCodes: [AUTO_BLOCK_REASON_CODES.LOW_LIQUIDITY_UNDER_1K],
    strongSignals: [],
    weakSignals: [AUTO_BLOCK_REASON_CODES.LOW_LIQUIDITY_UNDER_1K],
    behavioralSignals: [],
    positiveSignals: [],
    marketCap,
    liquidityUsd,
    confirmationBuckets: GLOBAL_LOW_LIQUIDITY_CONFIRMATION_BUCKETS,
    liquidityToMcapRatio: computeRatio(liquidityUsd, marketCap),
  };
}

function buildGmgnLowMcapThinSupportAssessment(row = {}, meteoraSummary = null, liquiditySamples = []) {
  const marketCap = toFiniteNumberOrNull(row.last_mcap);
  if (
    !isGmgnSource(row)
    || isManualReviewProtected(row)
    || !(marketCap >= DEFAULT_MIN_MCAP)
    || marketCap > GMGN_LOW_MCAP_THIN_SUPPORT_MAX_MCAP
    || !hasRequiredLowLiquidityConfirmation(row, liquiditySamples)
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
    reasonCodes: [AUTO_BLOCK_REASON_CODES.GMGN_LOW_MCAP_THIN_SUPPORT],
    strongSignals: [AUTO_BLOCK_REASON_CODES.GMGN_LOW_MCAP_THIN_SUPPORT],
    weakSignals: [],
    behavioralSignals: [],
    positiveSignals: [],
    marketCap,
    liquidityUsd: toFiniteNumberOrNull(row.last_liquidity_usd),
    volume1h: toFiniteNumberOrNull(row.last_vol_1h),
    volume6h: toFiniteNumberOrNull(row.last_vol_6h),
  };
}

function buildGmgnConfirmedMicroLiquidityAssessment(row = {}, liquiditySamples = []) {
  const marketCap = toFiniteNumberOrNull(row.last_mcap);
  const liquidityUsd = toFiniteNumberOrNull(row.last_liquidity_usd);
  const liquidityToMcap = computeRatio(liquidityUsd, marketCap);

  if (
    !isGmgnSource(row)
    || isManualReviewProtected(row)
    || !(marketCap >= DEFAULT_MIN_MCAP)
    || !hasRequiredLowLiquidityConfirmation(row, liquiditySamples)
    || !(liquidityUsd > 0)
    || liquidityUsd > GMGN_CONFIRMED_MICRO_LIQUIDITY_MAX_USD
    || liquidityToMcap == null
    || liquidityToMcap > GMGN_CONFIRMED_MICRO_LIQUIDITY_MAX_TO_MCAP
  ) {
    return null;
  }

  return {
    label: 'junk_probable',
    confidence: 'high',
    manualReviewRequired: true,
    autoBlock: false,
    mode: 'gmgn_confirmed_micro_liquidity_gate',
    strongSignalCount: 1,
    reasonCodes: [AUTO_BLOCK_REASON_CODES.GMGN_CONFIRMED_MICRO_LIQUIDITY],
    strongSignals: [AUTO_BLOCK_REASON_CODES.GMGN_CONFIRMED_MICRO_LIQUIDITY],
    weakSignals: [],
    behavioralSignals: [],
    positiveSignals: [],
    marketCap,
    liquidityUsd,
    liquidityToMcapRatio: liquidityToMcap,
  };
}

function buildGmgnLowMcapExtreme24hChurnAssessment(row = {}, liquiditySamples = []) {
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
    || !hasRequiredLowLiquidityConfirmation(row, liquiditySamples)
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
    reasonCodes: [AUTO_BLOCK_REASON_CODES.GMGN_LOW_MCAP_EXTREME_24H_CHURN_THIN_LIQUIDITY],
    strongSignals: [AUTO_BLOCK_REASON_CODES.GMGN_LOW_MCAP_EXTREME_24H_CHURN_THIN_LIQUIDITY],
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
  return liquidityUsd > 0
    && liquidityUsd <= GMGN_YOUNG_LOW_CAP_HIGH_CHURN_MAX_LIQUIDITY_USD
    && liquidityToMcap != null
    && liquidityToMcap <= GMGN_YOUNG_LOW_CAP_HIGH_CHURN_MAX_LIQUIDITY_TO_MCAP;
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

function buildGmgnYoungLowCapHighChurnAssessment(row = {}, meteoraSummary = null, liquiditySamples = []) {
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
    || !hasRequiredLowLiquidityConfirmation(row, liquiditySamples)
    || !hasYoungLowCapThinLiquidity(row)
    || !hasYoungLowCapHighChurnMarket(row)
    || !hasNoMeteoraPool(meteoraSummary)
  ) {
    return null;
  }

  return {
    label: 'junk_probable',
    confidence: 'high',
    manualReviewRequired: true,
    autoBlock: false,
    mode: 'gmgn_young_low_cap_high_churn_gate',
    strongSignalCount: 1,
    reasonCodes: [AUTO_BLOCK_REASON_CODES.GMGN_YOUNG_LOW_CAP_HIGH_CHURN_THIN_LIQUIDITY],
    strongSignals: [AUTO_BLOCK_REASON_CODES.GMGN_YOUNG_LOW_CAP_HIGH_CHURN_THIN_LIQUIDITY],
    weakSignals: [],
    behavioralSignals: [],
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
    reasonCodes: [AUTO_BLOCK_REASON_CODES.GMGN_HOLDER_COUNT_MCAP_ANOMALY],
    strongSignals: [AUTO_BLOCK_REASON_CODES.GMGN_HOLDER_COUNT_MCAP_ANOMALY],
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
    ? [
        AUTO_BLOCK_REASON_CODES.GMGN_YOUNG_EXTREME_CHURN,
        AUTO_BLOCK_REASON_CODES.GMGN_CONCENTRATED_STRUCTURE,
      ]
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
  return buildCommaSuffixAutoBlockLabel(AUTO_BLOCK_LABEL_PREFIXES.RISK_REVIEW_AUTO_JUNK_PROBABLE, reasonCodes);
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

function buildRiskReviewMarketSnapshot(row = {}) {
  return {
    mcap: toFiniteNumberOrNull(row.last_mcap),
    price: toFiniteNumberOrNull(row.last_price),
    vol5m: toFiniteNumberOrNull(row.last_vol_5m),
    vol1h: toFiniteNumberOrNull(row.last_vol_1h),
    vol6h: toFiniteNumberOrNull(row.last_vol_6h),
    vol24h: toFiniteNumberOrNull(row.last_vol_24h),
    liquidityUsd: toFiniteNumberOrNull(row.last_liquidity_usd),
    txns1hBuys: toFiniteNumberOrNull(row.last_txns_1h_buys),
    txns1hSells: toFiniteNumberOrNull(row.last_txns_1h_sells),
    txns24hBuys: toFiniteNumberOrNull(row.last_txns_24h_buys),
    txns24hSells: toFiniteNumberOrNull(row.last_txns_24h_sells),
    priceChange1h: toFiniteNumberOrNull(row.last_price_change_1h),
    priceChange6h: toFiniteNumberOrNull(row.last_price_change_6h),
    priceChange24h: toFiniteNumberOrNull(row.last_price_change_24h),
    tokenCreatedAtMs: toFiniteNumberOrNull(row.last_token_created_at_ms),
  };
}

function buildRiskReviewCatalogSnapshot(row = {}) {
  return {
    address: row.address || null,
    symbol: row.symbol || null,
    name: row.name || null,
    source: row.source || null,
    eligibilityState: row.eligibility_state || null,
    suppressedReason: row.suppressed_reason || null,
    riskReviewLabel: row.risk_review_label || null,
    riskReviewSource: row.risk_review_source || null,
  };
}

function buildRiskReviewRiskSnapshot(row = {}) {
  return {
    holderCount: toFiniteNumberOrNull(row.risk_holder_count),
    top10Pct: toFiniteNumberOrNull(row.risk_top_10_pct),
    top20Pct: toFiniteNumberOrNull(row.risk_top_20_pct),
    mintAuthorityActive: row.risk_mint_authority_active === true,
    freezeAuthorityActive: row.risk_freeze_authority_active === true,
    reasonCodes: Array.isArray(row.risk_reason_codes) ? row.risk_reason_codes : [],
  };
}

function buildRiskReviewMeteoraSnapshot(meteoraSummary = null) {
  if (!meteoraSummary) {
    return {};
  }
  return {
    hasPool: meteoraSummary.hasPool,
    currentTvl: toFiniteNumberOrNull(meteoraSummary.currentTvl),
    poolCount: Number(meteoraSummary.poolCount) || 0,
    bestPoolAddress: meteoraSummary.bestPoolAddress || null,
    source: meteoraSummary.source || null,
    updatedAt: meteoraSummary.updatedAt || null,
  };
}

function buildRiskReviewBlockEvidence(row, assessment, meteoraSummary) {
  const label = buildAutoBlockLabel(assessment);
  return {
    pipeline: 'risk-review-sync',
    source: row?.source || null,
    catalogSnapshot: buildRiskReviewCatalogSnapshot(row),
    marketSnapshot: buildRiskReviewMarketSnapshot(row),
    riskSnapshot: buildRiskReviewRiskSnapshot(row),
    meteoraSnapshot: buildRiskReviewMeteoraSnapshot(meteoraSummary),
    assessment: assessment || {},
    ruleMatches: [{ label, mode: assessment?.mode || null, reasonCodes: assessment?.reasonCodes || [] }],
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

async function autoBlockToken(row, assessment, deps = {}, meteoraSummary = null) {
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
    evidence: buildRiskReviewBlockEvidence(row, assessment, meteoraSummary),
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

async function listLowLiquiditySamplesByAddress(addresses, deps = {}) {
  const bucketModel = deps.tokenMarketBucket1mModel;
  if (!bucketModel?.listRecentLiquiditySamplesByAddresses) {
    return new Map();
  }

  const rows = await bucketModel.listRecentLiquiditySamplesByAddresses(
    addresses,
    GLOBAL_LOW_LIQUIDITY_CONFIRMATION_BUCKETS
  );
  return rows.reduce((acc, sample) => {
    const address = String(sample?.tokenAddress || sample?.token_address || '').trim();
    if (!address) {
      return acc;
    }
    if (!acc.has(address)) {
      acc.set(address, []);
    }
    acc.get(address).push(sample);
    return acc;
  }, new Map());
}

async function assessRiskReviewRow(row, meteoraSummary, deps = {}, liquiditySamples = []) {
  return buildGmgnRiskGateAssessment(row)
    || buildNewLowMcapExtremeVolumeAssessment(row)
    || buildGmgnLowMcapExtreme24hChurnAssessment(row, liquiditySamples)
    || buildGmgnYoungLowCapHighChurnAssessment(row, meteoraSummary, liquiditySamples)
    || buildGmgnLowMcapThinSupportAssessment(row, meteoraSummary, liquiditySamples)
    || buildGmgnConfirmedMicroLiquidityAssessment(row, liquiditySamples)
    || buildGlobalLowLiquidityAssessment(row, liquiditySamples)
    || await assessDexGmgnHolderAnomaly(row, deps)
    || buildLowLiquidityPendingConfirmationAssessment(row, liquiditySamples)
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
  const lowLiquiditySamplesByAddress = await listLowLiquiditySamplesByAddress(addresses, deps);

  let saved = 0;
  let autoBlocked = 0;
  let manualProtected = 0;
  let released = 0;

  for (const row of rows) {
    const meteoraSummary = meteoraByAddress.get(row.address) || null;
    const liquiditySamples = lowLiquiditySamplesByAddress.get(row.address) || [];
    const assessment = await assessRiskReviewRow(row, meteoraSummary, deps, liquiditySamples);

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

    if (shouldAutoBlockLabel(label) && await autoBlockToken(row, assessment, deps, meteoraSummary)) {
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
    const processDeps = {
      tokenMarketBucket1mModel: tokenMarketBucket1m,
      ...deps,
    };

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
      const rows = await listCandidates(offset, normalizedOptions, processDeps);
      const result = await processRows(rows, processDeps);

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
    buildGlobalLowLiquidityAssessment,
    buildLowLiquidityPendingConfirmationAssessment,
    hasConfirmedLowLiquiditySamples,
    hasRequiredLowLiquidityConfirmation,
    hasGmgnConcentratedStructure,
    hasStructuralCoverage,
    isGmgnRiskEnrichmentSuppressed,
    listCandidates,
    listLowLiquiditySamplesByAddress,
    normalizeAutoLabel,
    normalizePersistedAutoLabel,
    normalizeOptions,
    processRows,
    releaseGmgnRiskSuppression,
    shouldAutoBlockLabel,
  },
};
