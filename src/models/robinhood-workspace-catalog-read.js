const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');
const { evaluateWorkspaceVisibility } = require('../services/workspace-visibility-policy');

const CHAIN = 'robinhood';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;

const PERSISTENT_CATALOG_PAGE_SQL = `WITH catalog_page AS MATERIALIZED (
  SELECT
    catalog.address,
    catalog.symbol,
    catalog.name,
    catalog.source,
    catalog.first_seen_at,
    catalog.last_image_url,
    catalog.last_twitter_url,
    catalog.last_community_url,
    EXISTS (
      SELECT 1
      FROM admin_blocked_tokens blocked
      WHERE blocked.chain = 'robinhood'
        AND blocked.address = catalog.address
    ) AS admin_blocked
  FROM token_catalog catalog
  WHERE catalog.chain = 'robinhood'
    AND ($2::varchar IS NULL OR catalog.address > $2::varchar)
  ORDER BY catalog.address ASC
  LIMIT $3::int
)
SELECT
  catalog_page.*,
  activity.last_activity_at,
  valuation.last_fdv_usd,
  valuation.valuation_observed_at
FROM catalog_page
LEFT JOIN LATERAL (
  SELECT bucket.last_observed_at AS last_activity_at
  FROM robinhood_market_buckets_1h bucket
  WHERE bucket.chain = 'robinhood'
    AND bucket.token_address = catalog_page.address
    AND bucket.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
    AND bucket.bucket_ts < date_trunc('hour', $1::timestamptz) + INTERVAL '1 hour'
    AND bucket.last_observed_at <= $1::timestamptz
  ORDER BY bucket.bucket_ts DESC, bucket.last_block_number DESC,
    bucket.last_log_index DESC, bucket.protocol ASC, bucket.market_key ASC
  LIMIT 1
) activity ON TRUE
LEFT JOIN LATERAL (
  SELECT
    bucket.close_fdv_usd AS last_fdv_usd,
    bucket.last_observed_at AS valuation_observed_at
  FROM robinhood_market_buckets_1h bucket
  WHERE bucket.chain = 'robinhood'
    AND bucket.token_address = catalog_page.address
    AND bucket.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
    AND bucket.bucket_ts < date_trunc('hour', $1::timestamptz) + INTERVAL '1 hour'
    AND bucket.last_observed_at <= $1::timestamptz
    AND bucket.close_fdv_usd > 0
  ORDER BY bucket.bucket_ts DESC, bucket.last_block_number DESC,
    bucket.last_log_index DESC, bucket.protocol ASC, bucket.market_key ASC
  LIMIT 1
) valuation ON TRUE
ORDER BY catalog_page.address ASC`;

function parseTimestamp(value, label) {
  if (value == null || value === '') return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is invalid`);
  return parsed;
}

function normalizeLimit(value) {
  const parsed = value == null ? DEFAULT_LIMIT : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_LIMIT) {
    throw new RangeError(`limit must be a positive safe integer no greater than ${MAX_LIMIT}`);
  }
  return parsed;
}

function normalizeStatementTimeout(value) {
  const parsed = value == null ? DEFAULT_STATEMENT_TIMEOUT_MS : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1000 || parsed > 60_000) {
    throw new RangeError('statementTimeoutMs must be between 1000 and 60000');
  }
  return parsed;
}

function parseCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    return Object.freeze({
      asOf: parseTimestamp(parsed.asOf, 'cursor asOf'),
      address: normalizeTokenAddress(CHAIN, parsed.address),
    });
  } catch (_) {
    throw new Error('Invalid Robinhood workspace catalog cursor');
  }
}

function encodeCursor(address, asOf) {
  return Buffer.from(JSON.stringify({
    asOf: asOf.toISOString(),
    address: normalizeTokenAddress(CHAIN, address),
  })).toString('base64url');
}

function normalizeQuery(input = {}) {
  const cursor = parseCursor(input.cursor);
  const requestedAsOf = parseTimestamp(input.asOf, 'asOf');
  if (cursor && requestedAsOf && cursor.asOf.getTime() !== requestedAsOf.getTime()) {
    throw new Error('Cursor snapshot does not match requested asOf');
  }
  return Object.freeze({
    asOf: cursor?.asOf || requestedAsOf || new Date(),
    afterAddress: cursor?.address || null,
    limit: normalizeLimit(input.limit),
    statementTimeoutMs: normalizeStatementTimeout(input.statementTimeoutMs),
    filters: input.filters || {},
    activityFreshMs: input.activityFreshMs,
    valuationFreshMs: input.valuationFreshMs,
  });
}

function optionalIso(value, label) {
  return parseTimestamp(value, label)?.toISOString() || null;
}

function normalizeCatalogRow(row, query) {
  const address = normalizeTokenAddress(CHAIN, row.address);
  const lastActivityAt = optionalIso(row.last_activity_at, 'last activity timestamp');
  const valuationObservedAt = optionalIso(
    row.valuation_observed_at, 'valuation observation timestamp',
  );
  const visibility = evaluateWorkspaceVisibility({
    identity: { chain: CHAIN, address },
    state: { adminBlocked: row.admin_blocked === true, lastActivityAt },
    valuation: {
      type: 'fdv',
      usd: row.last_fdv_usd,
      observedAt: valuationObservedAt,
    },
    filters: query.filters,
  }, {
    nowMs: query.asOf.getTime(),
    activityFreshMs: query.activityFreshMs,
    valuationFreshMs: query.valuationFreshMs,
  });

  return Object.freeze({
    identity: visibility.identity,
    symbol: row.symbol == null ? null : String(row.symbol),
    name: row.name == null ? null : String(row.name),
    source: String(row.source || 'unknown'),
    firstSeenAt: optionalIso(row.first_seen_at, 'first seen timestamp'),
    imageUrl: row.last_image_url || null,
    twitterUrl: row.last_twitter_url || null,
    communityUrl: row.last_community_url || null,
    lastActivityAt,
    activityState: visibility.activityState,
    valuation: visibility.valuation,
    visible: visibility.visible,
    exclusionReasons: visibility.reasons,
    filterMismatch: visibility.filterMismatch,
    riskState: visibility.riskState,
    dataQuality: visibility.dataQuality,
    windowMetrics: Object.freeze({
      coverage: 'unavailable',
      reason: 'window_metric_adapter_required',
    }),
  });
}

function createRobinhoodWorkspaceCatalogReadRepository(options = {}) {
  const database = options.database || db;

  async function listCatalogPage(input = {}) {
    const query = normalizeQuery(input);
    const execute = typeof database.queryWithStatementTimeout === 'function'
      ? (sql, params) => database.queryWithStatementTimeout(
        sql, params, query.statementTimeoutMs,
      )
      : (sql, params) => database.query(sql, params);
    const result = await execute(PERSISTENT_CATALOG_PAGE_SQL, [
      query.asOf, query.afterAddress, query.limit + 1,
    ]);
    const selectedRows = result.rows.slice(0, query.limit);
    const rows = selectedRows.map((row) => normalizeCatalogRow(row, query));
    const hasMore = result.rows.length > query.limit;

    return Object.freeze({
      chain: CHAIN,
      asOf: query.asOf.toISOString(),
      rows: Object.freeze(rows),
      hasMore,
      nextCursor: hasMore && selectedRows.length
        ? encodeCursor(selectedRows[selectedRows.length - 1].address, query.asOf)
        : null,
    });
  }

  return Object.freeze({ listCatalogPage });
}

module.exports = {
  createRobinhoodWorkspaceCatalogReadRepository,
  __private: {
    PERSISTENT_CATALOG_PAGE_SQL,
    encodeCursor,
    normalizeCatalogRow,
    normalizeQuery,
    parseCursor,
  },
};
