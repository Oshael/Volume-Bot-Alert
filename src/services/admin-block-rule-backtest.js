const catalogWorker = require('./catalog-worker');
const gmgnCatalogIngestion = require('./gmgn-catalog-ingestion');
const riskReviewSyncWorker = require('./token-risk-review-sync-worker');
const { classifyTokenJunk } = require('./token-junk-metric');
const {
  AUTO_BLOCK_LABEL_PREFIXES,
} = require('./auto-block-rule-labels');

const STRUCTURED_LABEL_PREFIXES = [
  AUTO_BLOCK_LABEL_PREFIXES.CATALOG_YOUNG_EXTREME_CHURN,
  AUTO_BLOCK_LABEL_PREFIXES.GMGN_INFO_LOW_MCAP_HIGH_HOLDERS,
  AUTO_BLOCK_LABEL_PREFIXES.GMGN_KLINE_STAIRCASE_PUMP,
  AUTO_BLOCK_LABEL_PREFIXES.GMGN_NEW_NON_PUMP_HIGH_LAUNCH_MCAP,
  AUTO_BLOCK_LABEL_PREFIXES.GMGN_SECURITY_TOP10_HOLDER_RATE,
  AUTO_BLOCK_LABEL_PREFIXES.GMGN_VOLUME_LOW_MCAP_EXTREME_VOL5M,
];

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toDateOrNull(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function canonicalRuleIdFromLabel(label) {
  const raw = String(label || '').trim();
  if (!raw) {
    return '';
  }
  if (raw.startsWith(`${AUTO_BLOCK_LABEL_PREFIXES.GMGN_AUTO_JUNK}:`)) {
    return raw;
  }
  if (raw.startsWith(`${AUTO_BLOCK_LABEL_PREFIXES.RISK_REVIEW_AUTO_JUNK_PROBABLE}:`)) {
    return raw;
  }
  for (const prefix of STRUCTURED_LABEL_PREFIXES) {
    if (raw === prefix || raw.startsWith(`${prefix}:`) || raw.startsWith(`${prefix}-`)) {
      return prefix;
    }
  }
  return raw;
}

function buildRuleMatch({ pipeline, label, reason = null, confidence = null, note = null }) {
  return {
    pipeline,
    label,
    ruleId: canonicalRuleIdFromLabel(label),
    reason,
    confidence,
    note,
  };
}

function buildRiskReviewMatch(assessment, pipeline = 'risk-review') {
  if (!assessment || String(assessment.label || '').trim().toLowerCase() !== 'junk_probable') {
    return null;
  }
  return buildRuleMatch({
    pipeline,
    label: riskReviewSyncWorker.__private.buildAutoBlockLabel(assessment),
    reason: assessment.mode || null,
    confidence: assessment.confidence || null,
  });
}

function buildMeteoraSummaryFromRow(row = {}) {
  if (
    row.meteora_has_pool == null
    && row.meteora_current_tvl == null
    && row.meteora_pool_count == null
  ) {
    return null;
  }
  return {
    tokenAddress: row.address,
    hasPool: row.meteora_has_pool == null ? null : row.meteora_has_pool === true,
    currentTvl: toNumberOrNull(row.meteora_current_tvl),
    poolCount: Number(row.meteora_pool_count) || 0,
  };
}

function buildGmgnSnapshotFromRow(row = {}) {
  return {
    address: row.address,
    chain: 'sol',
    symbol: row.symbol || null,
    name: row.name || null,
    mcap: toNumberOrNull(row.last_mcap),
    vol1m: toNumberOrNull(row.last_vol_1m),
    vol5m: toNumberOrNull(row.last_vol_5m),
    vol1h: toNumberOrNull(row.last_vol_1h),
    vol6h: toNumberOrNull(row.last_vol_6h),
    vol24h: toNumberOrNull(row.last_vol_24h),
    liquidityUsd: toNumberOrNull(row.last_liquidity_usd),
    priceChange1h: toNumberOrNull(row.last_price_change_1h),
    priceChange6h: toNumberOrNull(row.last_price_change_6h),
    priceChange24h: toNumberOrNull(row.last_price_change_24h),
    txns1hBuys: toNumberOrNull(row.last_txns_1h_buys),
    txns1hSells: toNumberOrNull(row.last_txns_1h_sells),
    txns24hBuys: toNumberOrNull(row.last_txns_24h_buys),
    txns24hSells: toNumberOrNull(row.last_txns_24h_sells),
    tokenCreatedAt: row.last_token_created_at_ms ? new Date(Number(row.last_token_created_at_ms)) : null,
  };
}

function inferDryRunSource(row = {}) {
  const label = String(row.blocked_label || '').trim();
  if (String(row.source || '').trim().toLowerCase() !== 'admin-blocked') {
    return row.source || null;
  }
  if (label.startsWith('gmgn-') || label.startsWith('auto-junk-probable:gmgn_')) {
    return 'gmgn';
  }
  return 'dexscreener-discovery';
}

function buildDryRunTokenBefore(row = {}) {
  return {
    ...row,
    source: inferDryRunSource(row),
    eligibility_state: null,
    last_pair_url: row.last_pair_url || null,
  };
}

function evaluateRiskReviewMatches(row = {}, meteoraSummary = buildMeteoraSummaryFromRow(row)) {
  const priv = riskReviewSyncWorker.__private;
  const candidates = [
    priv.buildGmgnRiskGateAssessment(row),
    priv.buildNewLowMcapExtremeVolumeAssessment(row),
    priv.buildGmgnLowMcapExtreme24hChurnAssessment(row),
    priv.buildGmgnYoungLowCapHighChurnAssessment(row, meteoraSummary),
    priv.buildGmgnLowMcapThinSupportAssessment(row, meteoraSummary),
    priv.buildGmgnConfirmedMicroLiquidityAssessment(row),
    classifyTokenJunk({
      ...row,
      meteora: priv.buildMeteoraMetric(meteoraSummary),
    }),
  ];

  return candidates
    .map((assessment) => buildRiskReviewMatch(assessment))
    .filter(Boolean);
}

function evaluateOfflineGmgnIngestionMatches(row = {}) {
  const snapshot = buildGmgnSnapshotFromRow(row);
  const tokenBefore = buildDryRunTokenBefore(row);
  const bannedAt = toDateOrNull(row.banned_at) || new Date();
  const priv = gmgnCatalogIngestion.__private;
  const matches = [];
  const junkAssessment = priv.assessGmgnJunk(snapshot);

  if (priv.isHighConfidenceJunkAssessment(junkAssessment)) {
    matches.push(buildRuleMatch({
      pipeline: 'gmgn-ingestion',
      label: priv.buildGmgnAutoBlockLabel(junkAssessment),
      reason: 'gmgn_auto_junk',
      confidence: junkAssessment.confidence || null,
    }));
  }
  if (priv.isGmgnLowMcapExtremeVolumeRisk(snapshot, bannedAt)) {
    matches.push(buildRuleMatch({
      pipeline: 'gmgn-ingestion',
      label: priv.buildGmgnLowMcapExtremeVolumeLabel(snapshot),
      reason: 'gmgn_low_mcap_extreme_volume',
    }));
  }
  if (priv.isNewNonPumpHighLaunchMcapRisk(row.address, snapshot, tokenBefore, bannedAt)) {
    matches.push(buildRuleMatch({
      pipeline: 'gmgn-ingestion',
      label: priv.buildGmgnNewNonPumpHighLaunchMcapLabel(snapshot),
      reason: 'gmgn_new_non_pump_high_launch_mcap',
    }));
  }

  return matches;
}

function evaluateCatalogWorkerMatches(row = {}, initialBucket = null) {
  const now = toDateOrNull(row.banned_at)?.getTime() || Date.now();
  const assessment = catalogWorker.__private.assessYoungExtremeChurn(
    buildDryRunTokenBefore(row),
    {
      pairCreatedAt: row.last_token_created_at_ms ? new Date(Number(row.last_token_created_at_ms)) : null,
      baseToken: { symbol: row.symbol || null, name: row.name || null },
    },
    {
      marketCap: toNumberOrNull(row.last_mcap),
      vol5m: toNumberOrNull(row.last_vol_5m),
    },
    initialBucket,
    now
  );

  if (!assessment?.shouldBlock) {
    return [];
  }

  return [buildRuleMatch({
    pipeline: 'catalog-worker',
    label: catalogWorker.__private.buildYoungExtremeChurnLabel(assessment),
    reason: assessment.reason || 'young-extreme-churn',
  })];
}

function getEvidenceRuleIds(row = {}) {
  const assessment = row.evidence_assessment && typeof row.evidence_assessment === 'object'
    ? row.evidence_assessment
    : null;
  if (!assessment) {
    return [];
  }
  const reasonCodes = Array.isArray(assessment.reasonCodes) ? assessment.reasonCodes : [];
  if (reasonCodes.length) {
    return [canonicalRuleIdFromLabel(
      `${AUTO_BLOCK_LABEL_PREFIXES.RISK_REVIEW_AUTO_JUNK_PROBABLE}:${reasonCodes.slice(0, 3).join(',')}`
    )];
  }
  return [];
}

function evaluateBlockedToken(row = {}, options = {}) {
  const initialBucket = options.initialBucket || null;
  const matches = [
    ...evaluateOfflineGmgnIngestionMatches(row),
    ...evaluateRiskReviewMatches(row),
    ...evaluateCatalogWorkerMatches(row, initialBucket),
  ];
  const uniqueByRule = new Map(matches.map((match) => [match.ruleId, match]));
  const uniqueMatches = [...uniqueByRule.values()];
  const storedRuleId = canonicalRuleIdFromLabel(row.blocked_label);
  const evidenceRuleIds = getEvidenceRuleIds(row);
  const originalStillMatches = Boolean(storedRuleId && uniqueByRule.has(storedRuleId));

  return {
    address: row.address,
    symbol: row.symbol || null,
    name: row.name || null,
    bannedAt: row.banned_at || null,
    storedLabel: row.blocked_label || null,
    storedRuleId,
    matchingRules: uniqueMatches,
    matchCount: uniqueMatches.length,
    originalStillMatches,
    evidenceRuleIds,
    evidenceSupportsStoredRule: evidenceRuleIds.includes(storedRuleId),
    market: {
      mcap: toNumberOrNull(row.last_mcap),
      liquidityUsd: toNumberOrNull(row.last_liquidity_usd),
      vol5m: toNumberOrNull(row.last_vol_5m),
      vol1h: toNumberOrNull(row.last_vol_1h),
      vol24h: toNumberOrNull(row.last_vol_24h),
    },
  };
}

function summarizeBacktestResults(results = []) {
  return {
    total: results.length,
    zeroMatches: results.filter((row) => row.matchCount === 0).length,
    singleMatch: results.filter((row) => row.matchCount === 1).length,
    multipleMatches: results.filter((row) => row.matchCount > 1).length,
    originalStillMatches: results.filter((row) => row.originalStillMatches).length,
    evidenceSupportsStoredRule: results.filter((row) => row.evidenceSupportsStoredRule).length,
  };
}

module.exports = {
  evaluateBlockedToken,
  summarizeBacktestResults,
  __private: {
    buildDryRunTokenBefore,
    buildGmgnSnapshotFromRow,
    buildMeteoraSummaryFromRow,
    canonicalRuleIdFromLabel,
    evaluateCatalogWorkerMatches,
    evaluateOfflineGmgnIngestionMatches,
    evaluateRiskReviewMatches,
    getEvidenceRuleIds,
    inferDryRunSource,
    toDateOrNull,
    toNumberOrNull,
  },
};
