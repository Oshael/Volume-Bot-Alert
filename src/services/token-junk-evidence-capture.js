const crypto = require('node:crypto');

const tokenJunkEvidence = require('../models/token-junk-evidence');
const tokenMarketBucket1m = require('../models/token-market-bucket-1m');
const tokenMeteoraSnapshot = require('../models/token-meteora-snapshot');

const DEFAULT_MARKET_HISTORY_DAYS = 7;
const DEFAULT_MARKET_HISTORY_LIMIT = 500;
const DEFAULT_METEORA_HISTORY_DAYS = 7;
const DEFAULT_METEORA_HISTORY_LIMIT = 168;
const MAX_STORED_MARKET_POINTS = 120;
const MAX_STORED_METEORA_POINTS = 96;

function toNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundMetric(value, digits = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Number(parsed.toFixed(digits));
}

function computeSampleStddev(values) {
  const numeric = (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  if (numeric.length < 2) {
    return null;
  }

  const mean = numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
  const variance = numeric.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (numeric.length - 1);
  return Math.sqrt(variance);
}

function computeRangePct(minValue, maxValue, averageValue) {
  const min = Number(minValue);
  const max = Number(maxValue);
  const average = Number(averageValue);
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(average) || !(average > 0)) {
    return null;
  }
  return ((max - min) / average) * 100;
}

function computeDriftPct(firstValue, lastValue) {
  const first = Number(firstValue);
  const last = Number(lastValue);
  if (!Number.isFinite(first) || !Number.isFinite(last) || !(first > 0)) {
    return null;
  }
  return ((last - first) / first) * 100;
}

function buildSeriesStats(values, digits = 2) {
  const numeric = (Array.isArray(values) ? values : []).filter((value) => value != null);
  if (!numeric.length) {
    return { min: null, max: null, avg: null, stddev: null };
  }

  const min = Math.min(...numeric);
  const max = Math.max(...numeric);
  const avg = numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
  return {
    min: roundMetric(min, digits),
    max: roundMetric(max, digits),
    avg: roundMetric(avg, digits),
    stddev: roundMetric(computeSampleStddev(numeric), digits),
  };
}

function sampleSeries(items, maxPoints, mapper) {
  const list = Array.isArray(items) ? items : [];
  if (list.length <= maxPoints) {
    return list.map(mapper);
  }

  const points = [];
  const lastIndex = list.length - 1;
  const step = lastIndex / (maxPoints - 1);
  for (let index = 0; index < maxPoints; index += 1) {
    const sourceIndex = Math.round(index * step);
    points.push(mapper(list[sourceIndex]));
  }
  return points;
}

function buildFingerprintMarketContext(row) {
  return {
    marketCap: roundMetric(toNumberOrNull(row?.last_mcap), 2),
    volume1h: roundMetric(toNumberOrNull(row?.last_vol_1h), 2),
    volume24h: roundMetric(toNumberOrNull(row?.last_vol_24h), 2),
    liquidityUsd: roundMetric(toNumberOrNull(row?.last_liquidity_usd), 2),
    txns24hBuys: toNumberOrNull(row?.last_txns_24h_buys),
    txns24hSells: toNumberOrNull(row?.last_txns_24h_sells),
  };
}

function buildFingerprintRiskContext(row) {
  return {
    holderCount: toNumberOrNull(row?.risk_holder_count),
    top10Pct: roundMetric(toNumberOrNull(row?.risk_top_10_pct), 4),
    top20Pct: roundMetric(toNumberOrNull(row?.risk_top_20_pct), 4),
  };
}

function buildFingerprintMeteoraContext(meteoraSummary) {
  return {
    noPool: meteoraSummary?.hasPool === true ? false : true,
    poolCount: Number(meteoraSummary?.poolCount) || 0,
    currentTvl: roundMetric(toNumberOrNull(meteoraSummary?.currentTvl), 2),
  };
}

function readRoundedField(row, key, digits = 2) {
  return roundMetric(toNumberOrNull(row?.[key]), digits);
}

function readNumericField(row, key) {
  return toNumberOrNull(row?.[key]);
}

function readTextField(row, key) {
  return row?.[key] || null;
}

function readNullableBooleanField(row, key) {
  return row?.[key] == null ? null : Boolean(row[key]);
}

function buildAssessmentFingerprint(row, assessment, meteoraSummary) {
  const fingerprintInput = {
    label: String(assessment?.label || '').trim().toLowerCase() || null,
    reasonCodes: Array.isArray(assessment?.reasonCodes) ? assessment.reasonCodes : [],
    ...buildFingerprintMarketContext(row),
    ...buildFingerprintRiskContext(row),
    ...buildFingerprintMeteoraContext(meteoraSummary),
  };

  return crypto
    .createHash('sha1')
    .update(JSON.stringify(fingerprintInput))
    .digest('hex');
}

function buildCatalogMarketSnapshot(row) {
  return {
    symbol: readTextField(row, 'symbol'),
    name: readTextField(row, 'name'),
    marketCap: readRoundedField(row, 'last_mcap'),
    price: readRoundedField(row, 'last_price', 8),
    volume5m: readRoundedField(row, 'last_vol_5m'),
    volume1h: readRoundedField(row, 'last_vol_1h'),
    volume6h: readRoundedField(row, 'last_vol_6h'),
    volume24h: readRoundedField(row, 'last_vol_24h'),
    liquidityUsd: readRoundedField(row, 'last_liquidity_usd'),
    txns1hBuys: readNumericField(row, 'last_txns_1h_buys'),
    txns1hSells: readNumericField(row, 'last_txns_1h_sells'),
    txns24hBuys: readNumericField(row, 'last_txns_24h_buys'),
    txns24hSells: readNumericField(row, 'last_txns_24h_sells'),
    priceChange1h: readRoundedField(row, 'last_price_change_1h'),
    priceChange6h: readRoundedField(row, 'last_price_change_6h'),
    priceChange24h: readRoundedField(row, 'last_price_change_24h'),
    tokenCreatedAtMs: readNumericField(row, 'last_token_created_at_ms'),
    pairAddress: readTextField(row, 'last_pair_address'),
    pairUrl: readTextField(row, 'last_pair_url'),
    imageUrl: readTextField(row, 'last_image_url'),
  };
}

function buildRiskEnrichmentSnapshot(row) {
  return {
    holderCount: readNumericField(row, 'risk_holder_count'),
    top10Pct: readRoundedField(row, 'risk_top_10_pct', 4),
    top20Pct: readRoundedField(row, 'risk_top_20_pct', 4),
    mintAuthorityActive: readNullableBooleanField(row, 'risk_mint_authority_active'),
    freezeAuthorityActive: readNullableBooleanField(row, 'risk_freeze_authority_active'),
    reasonCodes: Array.isArray(row?.risk_reason_codes) ? row.risk_reason_codes : [],
    lastEnrichedAt: readTextField(row, 'risk_enrichment_last_enriched_at'),
  };
}

function buildCatalogSnapshot(row, assessment) {
  return {
    ...buildCatalogMarketSnapshot(row),
    riskEnrichment: buildRiskEnrichmentSnapshot(row),
    assessmentLabel: String(assessment?.label || '').trim().toLowerCase() || null,
  };
}

function buildMarketHistoryPayload(snapshots) {
  const items = Array.isArray(snapshots) ? snapshots : [];
  const first = items[0] || null;
  const last = items[items.length - 1] || null;
  const mcapValues = items.map((item) => toNumberOrNull(item?.mcap)).filter((value) => value != null);
  const priceValues = items.map((item) => toNumberOrNull(item?.price)).filter((value) => value != null);
  const mcapStats = buildSeriesStats(mcapValues);
  const priceStats = buildSeriesStats(priceValues, 6);

  return {
    summary: {
      snapshotCount: items.length,
      firstTs: first?.ts || null,
      lastTs: last?.ts || null,
      firstMcap: roundMetric(toNumberOrNull(first?.mcap), 2),
      lastMcap: roundMetric(toNumberOrNull(last?.mcap), 2),
      rangePct: roundMetric(computeRangePct(mcapStats.min, mcapStats.max, mcapStats.avg)),
      driftPct: roundMetric(computeDriftPct(first?.mcap, last?.mcap)),
      mcapStddev: mcapStats.stddev,
      priceRangePct: roundMetric(computeRangePct(priceStats.min, priceStats.max, priceStats.avg)),
      latestPairAddress: last?.pairAddress || null,
    },
    points: sampleSeries(items, MAX_STORED_MARKET_POINTS, (item) => ({
      ts: item?.ts || null,
      mcap: roundMetric(toNumberOrNull(item?.mcap), 2),
      price: roundMetric(toNumberOrNull(item?.price), 8),
      pairAddress: item?.pairAddress || null,
      sampleCount: Number(item?.sampleCount) || 0,
    })),
  };
}

function buildMeteoraHistorySummary(items, currentSummary) {
  const first = items[0] || null;
  const last = items[items.length - 1] || null;
  const tvlValues = items.map((item) => toNumberOrNull(item?.total_tvl ?? item?.totalTvl)).filter((value) => value != null);
  const tvlStats = buildSeriesStats(tvlValues);

  return {
    snapshotCount: items.length,
    firstTs: first?.ts || null,
    lastTs: last?.ts || null,
    latestTvl: resolveLatestTvl(currentSummary, last),
    minTvl: tvlStats.min,
    maxTvl: tvlStats.max,
    avgTvl: tvlStats.avg,
    rangePct: roundMetric(computeRangePct(tvlStats.min, tvlStats.max, tvlStats.avg)),
    ...buildMeteoraCurrentSummary(currentSummary),
  };
}

function buildMeteoraPoint(item) {
  return {
    ts: item?.ts || null,
    totalTvl: roundMetric(toNumberOrNull(item?.total_tvl ?? item?.totalTvl), 2),
    poolCount: Number(item?.pool_count ?? item?.poolCount) || 0,
    bestPoolAddress: item?.best_pool_address || item?.bestPoolAddress || null,
  };
}

function resolveLatestTvl(currentSummary, lastSnapshot) {
  return roundMetric(
    toNumberOrNull(currentSummary?.currentTvl ?? lastSnapshot?.total_tvl ?? lastSnapshot?.totalTvl),
    2
  );
}

function buildMeteoraCurrentSummary(currentSummary) {
  return {
    noPool: currentSummary?.hasPool === true ? false : true,
    poolCount: Number(currentSummary?.poolCount) || 0,
    bestPoolAddress: currentSummary?.bestPoolAddress || null,
    lastCheckedAt: currentSummary?.lastCheckedAt || null,
  };
}

function buildMeteoraHistoryPayload(snapshots, currentSummary) {
  const items = Array.isArray(snapshots) ? snapshots : [];
  return {
    summary: buildMeteoraHistorySummary(items, currentSummary),
    points: sampleSeries(items, MAX_STORED_METEORA_POINTS, buildMeteoraPoint),
  };
}

function buildAssessmentSignalPayload(assessment) {
  return {
    reasonCodes: Array.isArray(assessment?.reasonCodes) ? assessment.reasonCodes : [],
    strongSignals: Array.isArray(assessment?.strongSignals) ? assessment.strongSignals : [],
    weakSignals: Array.isArray(assessment?.weakSignals) ? assessment.weakSignals : [],
    behavioralSignals: Array.isArray(assessment?.behavioralSignals) ? assessment.behavioralSignals : [],
    positiveSignals: Array.isArray(assessment?.positiveSignals) ? assessment.positiveSignals : [],
  };
}

function buildAssessmentMetricPayload(assessment) {
  return {
    marketCap: roundMetric(toNumberOrNull(assessment?.marketCap), 2),
    liquidityUsd: roundMetric(toNumberOrNull(assessment?.liquidityUsd), 2),
    liquidityToMcapRatio: roundMetric(toNumberOrNull(assessment?.liquidityToMcapRatio), 6),
    volToMcapRatio: roundMetric(toNumberOrNull(assessment?.volToMcapRatio), 6),
    txns24hTotal: toNumberOrNull(assessment?.txns24hTotal),
    buySellImbalanceRatio24h: roundMetric(toNumberOrNull(assessment?.buySellImbalanceRatio24h), 6),
  };
}

function buildAssessmentPayload(assessment) {
  return {
    label: String(assessment?.label || '').trim().toLowerCase() || null,
    confidence: assessment?.confidence || null,
    mode: assessment?.mode || null,
    manualReviewRequired: Boolean(assessment?.manualReviewRequired),
    strongSignalCount: Number(assessment?.strongSignalCount) || 0,
    ...buildAssessmentSignalPayload(assessment),
    ...buildAssessmentMetricPayload(assessment),
  };
}

async function captureJunkEvidence(row, assessment, meteoraSummary, deps = {}) {
  const label = String(assessment?.label || '').trim().toLowerCase();
  if (label !== 'junk_probable' && label !== 'junk_permanent') {
    return { saved: false, skipped: 'non_junk_label' };
  }

  const evidenceModel = deps.tokenJunkEvidenceModel || tokenJunkEvidence;
  const marketHistoryModel = deps.tokenMarketBucket1mModel || tokenMarketBucket1m;
  const meteoraSnapshotModel = deps.tokenMeteoraSnapshotModel || tokenMeteoraSnapshot;
  const tokenAddress = String(row?.address || '').trim();
  const fingerprint = buildAssessmentFingerprint(row, assessment, meteoraSummary);

  if (await evidenceModel.hasFingerprint(tokenAddress, fingerprint)) {
    return { saved: false, skipped: 'duplicate', fingerprint };
  }

  const [marketSnapshots, meteoraSnapshots] = await Promise.all([
    marketHistoryModel.listHistoryByAddress(tokenAddress, {
      days: DEFAULT_MARKET_HISTORY_DAYS,
      limit: DEFAULT_MARKET_HISTORY_LIMIT,
    }),
    meteoraSnapshotModel.listHistoryByAddress(tokenAddress, {
      days: DEFAULT_METEORA_HISTORY_DAYS,
      limit: DEFAULT_METEORA_HISTORY_LIMIT,
    }),
  ]);

  const evidence = await evidenceModel.createEvidence({
    tokenAddress,
    label: label === 'junk_permanent' ? 'junk_probable' : label,
    source: 'auto_sync',
    assessmentFingerprint: fingerprint,
    assessment: buildAssessmentPayload(assessment),
    catalogSnapshot: buildCatalogSnapshot(row, assessment),
    marketHistory: buildMarketHistoryPayload(marketSnapshots),
    meteoraHistory: buildMeteoraHistoryPayload(meteoraSnapshots, meteoraSummary),
  });

  return {
    saved: Boolean(evidence),
    fingerprint,
    evidence,
  };
}

module.exports = {
  captureJunkEvidence,
  __private: {
    buildAssessmentFingerprint,
    buildAssessmentPayload,
    buildCatalogSnapshot,
    buildMarketHistoryPayload,
    buildMeteoraHistoryPayload,
    buildMeteoraHistorySummary,
    buildMeteoraPoint,
    buildFingerprintMarketContext,
    buildFingerprintRiskContext,
    buildFingerprintMeteoraContext,
    buildMeteoraCurrentSummary,
    buildCatalogMarketSnapshot,
    buildRiskEnrichmentSnapshot,
    buildAssessmentSignalPayload,
    buildAssessmentMetricPayload,
    resolveLatestTvl,
    sampleSeries,
    computeDriftPct,
    computeRangePct,
    buildSeriesStats,
    roundMetric,
    toNumberOrNull,
  },
};
