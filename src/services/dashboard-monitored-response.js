const { createTokenIdentity } = require('../utils/token-identity');
const { normalizeSocialLinkFields } = require('../utils/dex-social-links');

function optionalNumber(value, label) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

function timestampMs(value, label) {
  if (value == null || value === '') return null;
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

function optionalValue(value) {
  return value == null ? null : value;
}

function valuationFields(row) {
  const type = row?.valuation?.type;
  if (!['mcap', 'fdv'].includes(type)) throw new Error('valuation type is invalid');
  const usd = optionalNumber(row.valuation.usd, 'valuation usd');
  return {
    mcap: type === 'mcap' ? usd : null,
    fdv: type === 'fdv' ? usd : null,
    valuationType: usd == null ? null : (type === 'mcap' ? 'market-cap' : 'fdv'),
  };
}

function buildDashboardMonitoredToken(row, options = {}) {
  const identity = createTokenIdentity(
    row?.identity?.chain || row?.chain,
    row?.identity?.address || row?.address,
  );
  const social = normalizeSocialLinkFields({
    twitterUrl: row.twitterUrl,
    communityUrl: row.communityUrl,
  });
  return Object.freeze({
    chain: identity.chain,
    address: identity.address,
    symbol: optionalValue(row.symbol),
    name: optionalValue(row.name),
    source: optionalValue(row.source) || 'unknown',
    pairAddress: optionalValue(row.pairAddress),
    pairUrl: optionalValue(row.pairUrl),
    pairDexId: optionalValue(row.pairDexId),
    imageUrl: optionalValue(row.imageUrl),
    launchpadId: optionalValue(row.launchpadId),
    twitterUrl: social.twitterUrl,
    communityUrl: social.communityUrl,
    monitorPriority: optionalValue(row.monitorPriority),
    ...valuationFields(row),
    valuation: row.valuation,
    priceUsd: optionalNumber(row.priceUsd, 'priceUsd'),
    liquidityUsd: optionalNumber(row.liquidityUsd, 'liquidityUsd'),
    volume5m: row.volume5mUsd,
    prevVolume5mCanonical: optionalNumber(
      row.prevVolume5mCanonical, 'prevVolume5mCanonical',
    ),
    volume5mBaselineAt: optionalValue(row.volume5mBaselineAt),
    volume5mWindowEnd: optionalValue(row.volume5mWindowEnd),
    volume5mDeltaCoverage: optionalValue(row.volume5mDeltaCoverage) || 'unavailable',
    volume1h: row.volume1hUsd,
    volume6h: row.volume6hUsd,
    volume24h: row.volume24hUsd,
    priceChange1h: row.priceChange1hPct,
    priceChange6h: row.priceChange6hPct,
    priceChange24h: row.priceChange24hPct,
    pinnedSortOrder: optionalNumber(options.pinnedSortOrder, 'pinnedSortOrder'),
    filterMismatch: options.filterMismatch || [],
    tokenCreatedAt: optionalNumber(row.tokenCreatedAt, 'tokenCreatedAt'),
    tokenAgeProvenance: optionalValue(row.tokenAgeProvenance) || 'unknown',
    catalogFirstSeenAt: timestampMs(row.firstSeenAt, 'firstSeenAt'),
    firstSeenAt: optionalValue(row.firstSeenAt),
    lastSeenAt: optionalValue(row.lastSeenAt),
    lastEvaluatedAt: optionalValue(row.lastEvaluatedAt),
    windowEnd: row.windowEnd,
    lastActivityAt: row.lastActivityAt,
    volume5mUsd: row.volume5mUsd,
    volume1hUsd: row.volume1hUsd,
    volume6hUsd: row.volume6hUsd,
    volume24hUsd: row.volume24hUsd,
    swaps5m: row.swaps5m,
    swaps1h: row.swaps1h,
    swaps6h: row.swaps6h,
    swaps24h: row.swaps24h,
    coverage: row.coverage,
    swapCoverage: row.swapCoverage,
    priceChangeCoverage: row.priceChangeCoverage,
    activityState: row.activityState,
    riskState: row.riskState,
    dataQuality: row.dataQuality,
  });
}

function buildDashboardMonitoredPayload(page, options = {}) {
  if (!page || !Array.isArray(page.rows)) throw new Error('monitored page is invalid');
  const pinnedRows = options.pinnedRows || [];
  if (!Array.isArray(pinnedRows)) throw new Error('pinnedRows must be an array');
  return Object.freeze({
    generatedAt: page.asOf,
    asOf: page.asOf,
    total: page.total,
    page: page.page,
    perPage: page.perPage,
    hasMore: page.hasMore,
    tokens: Object.freeze(page.rows.map((row) => buildDashboardMonitoredToken(row))),
    pinnedTokens: Object.freeze(pinnedRows.map(({ row, sortOrder, filterMismatch }) => (
      buildDashboardMonitoredToken(row, { pinnedSortOrder: sortOrder, filterMismatch })
    ))),
    coverage: options.coverage || {},
  });
}

module.exports = { buildDashboardMonitoredPayload, buildDashboardMonitoredToken };
