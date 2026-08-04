require('dotenv').config();

const db = require('../models/db');

const GRANULARITIES = Object.freeze([5, 15, 30, 60, 240, 1440]);
const SOURCE_BY_GRANULARITY = Object.freeze(new Map([
  [5, { table: 'robinhood_market_buckets_1m', minutes: 1 }],
  [15, { table: 'robinhood_market_buckets_1m', minutes: 1 }],
  [30, { table: 'robinhood_market_buckets_1m', minutes: 1 }],
  [60, { table: 'robinhood_market_buckets_1h', minutes: 60 }],
  [240, { table: 'robinhood_market_buckets_1h', minutes: 60 }],
  [1440, { table: 'robinhood_market_buckets_1h', minutes: 60 }],
]));
const DEFAULT_DAYS = 3;

const TOKEN_PAGE_SQL = `WITH candidates AS (
  (SELECT token_address FROM robinhood_market_buckets_1m
  WHERE chain = 'robinhood' AND ($3::text IS NULL OR token_address > $3)
    AND bucket_ts >= $1 AND bucket_ts < $2
  GROUP BY token_address ORDER BY token_address LIMIT ($4::int + 1))
  UNION
  (SELECT token_address FROM robinhood_market_buckets_1h
  WHERE chain = 'robinhood' AND ($3::text IS NULL OR token_address > $3)
    AND bucket_ts >= $1 AND bucket_ts < $2
  GROUP BY token_address ORDER BY token_address LIMIT ($4::int + 1))
  UNION
  (SELECT token_address FROM robinhood_market_buckets_agg
  WHERE chain = 'robinhood' AND ($3::text IS NULL OR token_address > $3)
    AND bucket_ts >= $1 AND bucket_ts < $2
  GROUP BY token_address ORDER BY token_address LIMIT ($4::int + 1))
)
SELECT token_address
FROM candidates
ORDER BY token_address
LIMIT ($4::int + 1)`;

const HOURLY_FIELDS = Object.freeze([
  'token_address', 'protocol', 'market_key', 'quote_address', 'bucket_ts',
  'open_price_usd', 'high_price_usd', 'low_price_usd', 'close_price_usd',
  'open_fdv_usd', 'high_fdv_usd', 'low_fdv_usd', 'close_fdv_usd',
  'volume_usd', 'swaps', 'buys', 'sells', 'transactions',
  'source_minute_buckets', 'first_observed_at', 'first_block_number',
  'first_log_index', 'last_observed_at', 'last_block_number', 'last_log_index',
]);
const AGGREGATE_FIELDS = Object.freeze([
  'token_address', 'granularity_minutes', 'bucket_ts',
  'open_price_usd', 'high_price_usd', 'low_price_usd', 'close_price_usd',
  'open_fdv_usd', 'high_fdv_usd', 'low_fdv_usd', 'close_fdv_usd',
  'valuation_protocol', 'valuation_market_key', 'valuation_volume_24h_usd',
  'volume_usd', 'swaps', 'buys', 'sells', 'transactions', 'market_count',
  'protocols', 'source_granularity_minutes', 'source_bucket_count',
  'first_observed_at', 'first_block_number', 'first_log_index',
  'last_observed_at', 'last_block_number', 'last_log_index',
]);

function mismatchSql(fields) {
  return fields.map((field) => `expected.${field} IS DISTINCT FROM actual.${field}`).join('\n      OR ');
}

function summarySql(expectedSql, actualSql, joinSql, mismatchFields) {
  return `WITH expected AS MATERIALIZED (${expectedSql}),
actual AS MATERIALIZED (${actualSql}),
compared AS (
  SELECT COALESCE(expected.token_address, actual.token_address) AS token_address,
    COALESCE(expected.bucket_ts, actual.bucket_ts) AS bucket_ts,
    CASE
      WHEN expected.token_address IS NULL THEN 'orphan'
      WHEN actual.token_address IS NULL THEN 'missing'
      WHEN ${mismatchSql(mismatchFields)} THEN 'divergent'
      ELSE 'match'
    END AS status
  FROM expected
  FULL JOIN actual ON ${joinSql}
),
token_scope AS (SELECT UNNEST($1::text[]) AS token_address)
SELECT token_scope.token_address,
  COUNT(compared.*) FILTER (WHERE compared.status = 'match')::int AS matched_buckets,
  COUNT(compared.*) FILTER (WHERE compared.status = 'missing')::int AS missing_buckets,
  COUNT(compared.*) FILTER (WHERE compared.status = 'orphan')::int AS orphan_buckets,
  COUNT(compared.*) FILTER (WHERE compared.status = 'divergent')::int AS divergent_buckets,
  MIN(compared.bucket_ts) FILTER (WHERE compared.status <> 'match') AS first_mismatch_at,
  COALESCE(
    MIN(compared.bucket_ts) FILTER (WHERE compared.status <> 'match'),
    $3::timestamptz
  ) AS watermark
FROM token_scope
LEFT JOIN compared USING (token_address)
GROUP BY token_scope.token_address
ORDER BY token_scope.token_address`;
}

function buildHourlyAuditSql() {
  const expected = `SELECT minute.token_address, minute.protocol, minute.market_key,
    (array_agg(minute.quote_address ORDER BY minute.first_block_number,
      minute.first_log_index))[1] AS quote_address,
    date_trunc('hour', minute.bucket_ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      AS bucket_ts,
    (array_agg(minute.open_price_usd ORDER BY minute.first_block_number,
      minute.first_log_index))[1] AS open_price_usd,
    MAX(minute.high_price_usd) AS high_price_usd,
    MIN(minute.low_price_usd) AS low_price_usd,
    (array_agg(minute.close_price_usd ORDER BY minute.last_block_number DESC,
      minute.last_log_index DESC))[1] AS close_price_usd,
    (array_agg(minute.open_fdv_usd ORDER BY minute.first_block_number,
      minute.first_log_index))[1] AS open_fdv_usd,
    MAX(minute.high_fdv_usd) AS high_fdv_usd,
    MIN(minute.low_fdv_usd) AS low_fdv_usd,
    (array_agg(minute.close_fdv_usd ORDER BY minute.last_block_number DESC,
      minute.last_log_index DESC))[1] AS close_fdv_usd,
    SUM(minute.volume_usd) AS volume_usd, SUM(minute.swaps)::bigint AS swaps,
    SUM(minute.buys)::bigint AS buys, SUM(minute.sells)::bigint AS sells,
    SUM(minute.transactions)::bigint AS transactions,
    COUNT(*)::smallint AS source_minute_buckets,
    (array_agg(minute.first_observed_at ORDER BY minute.first_block_number,
      minute.first_log_index))[1] AS first_observed_at,
    MIN(minute.first_block_number) AS first_block_number,
    (array_agg(minute.first_log_index ORDER BY minute.first_block_number,
      minute.first_log_index))[1] AS first_log_index,
    (array_agg(minute.last_observed_at ORDER BY minute.last_block_number DESC,
      minute.last_log_index DESC))[1] AS last_observed_at,
    MAX(minute.last_block_number) AS last_block_number,
    (array_agg(minute.last_log_index ORDER BY minute.last_block_number DESC,
      minute.last_log_index DESC))[1] AS last_log_index
  FROM robinhood_market_buckets_1m minute
  WHERE minute.chain = 'robinhood' AND minute.token_address = ANY($1)
    AND minute.bucket_ts >= $2 AND minute.bucket_ts < $3
  GROUP BY minute.token_address, minute.protocol, minute.market_key,
    date_trunc('hour', minute.bucket_ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
  const actual = `SELECT ${HOURLY_FIELDS.join(', ')}
  FROM robinhood_market_buckets_1h
  WHERE chain = 'robinhood' AND token_address = ANY($1)
    AND bucket_ts >= $2 AND bucket_ts < $3`;
  const identity = `expected.token_address = actual.token_address
    AND expected.protocol = actual.protocol AND expected.market_key = actual.market_key
    AND expected.bucket_ts = actual.bucket_ts`;
  return summarySql(expected, actual, identity, HOURLY_FIELDS);
}

function buildAggregateAuditSql(granularityMinutes) {
  const source = SOURCE_BY_GRANULARITY.get(granularityMinutes);
  if (!source) throw new TypeError('granularityMinutes is unsupported');
  const expected = `WITH source_buckets AS MATERIALIZED (
    SELECT bucket.*,
      date_bin(INTERVAL '${granularityMinutes} minutes', bucket.bucket_ts,
        TIMESTAMPTZ '1970-01-01 00:00:00+00') AS aggregate_bucket_ts
    FROM ${source.table} bucket
    WHERE bucket.chain = 'robinhood' AND bucket.token_address = ANY($1)
      AND bucket.bucket_ts >= $2 AND bucket.bucket_ts < $3
  ), target_markets AS MATERIALIZED (
    SELECT DISTINCT token_address, aggregate_bucket_ts, protocol, market_key
    FROM source_buckets
  ), market_activity AS MATERIALIZED (
    SELECT target.token_address, target.aggregate_bucket_ts,
      target.protocol, target.market_key,
      COALESCE(SUM(history.volume_usd), 0) AS volume_24h_usd,
      MAX(history.last_observed_at) AS last_observed_at
    FROM target_markets target
    LEFT JOIN ${source.table} history
      ON history.chain = 'robinhood'
     AND history.token_address = target.token_address
     AND history.protocol = target.protocol
     AND history.market_key = target.market_key
     AND history.bucket_ts >= target.aggregate_bucket_ts
       + INTERVAL '${granularityMinutes} minutes' - INTERVAL '24 hours'
     AND history.bucket_ts < target.aggregate_bucket_ts
       + INTERVAL '${granularityMinutes} minutes'
    GROUP BY target.token_address, target.aggregate_bucket_ts,
      target.protocol, target.market_key
  ), primary_markets AS MATERIALIZED (
    SELECT DISTINCT ON (activity.token_address, activity.aggregate_bucket_ts)
      activity.token_address, activity.aggregate_bucket_ts,
      activity.protocol AS valuation_protocol,
      activity.market_key AS valuation_market_key,
      activity.volume_24h_usd AS valuation_volume_24h_usd
    FROM market_activity activity
    ORDER BY activity.token_address, activity.aggregate_bucket_ts,
      activity.volume_24h_usd DESC, activity.last_observed_at DESC NULLS LAST,
      activity.protocol, activity.market_key
  )
  SELECT bucket.token_address, ${granularityMinutes}::smallint AS granularity_minutes,
    bucket.aggregate_bucket_ts AS bucket_ts,
    (array_agg(bucket.open_price_usd ORDER BY bucket.first_block_number,
      bucket.first_log_index, bucket.protocol, bucket.market_key) FILTER (WHERE
        bucket.protocol = primary.valuation_protocol
        AND bucket.market_key = primary.valuation_market_key))[1] AS open_price_usd,
    MAX(bucket.high_price_usd) FILTER (WHERE
      bucket.protocol = primary.valuation_protocol
      AND bucket.market_key = primary.valuation_market_key) AS high_price_usd,
    MIN(bucket.low_price_usd) FILTER (WHERE
      bucket.protocol = primary.valuation_protocol
      AND bucket.market_key = primary.valuation_market_key) AS low_price_usd,
    (array_agg(bucket.close_price_usd ORDER BY bucket.last_block_number DESC,
      bucket.last_log_index DESC, bucket.protocol DESC, bucket.market_key DESC) FILTER (WHERE
        bucket.protocol = primary.valuation_protocol
        AND bucket.market_key = primary.valuation_market_key))[1] AS close_price_usd,
    (array_agg(bucket.open_fdv_usd ORDER BY bucket.first_block_number,
      bucket.first_log_index, bucket.protocol, bucket.market_key) FILTER (WHERE
        bucket.protocol = primary.valuation_protocol
        AND bucket.market_key = primary.valuation_market_key))[1] AS open_fdv_usd,
    MAX(bucket.high_fdv_usd) FILTER (WHERE
      bucket.protocol = primary.valuation_protocol
      AND bucket.market_key = primary.valuation_market_key) AS high_fdv_usd,
    MIN(bucket.low_fdv_usd) FILTER (WHERE
      bucket.protocol = primary.valuation_protocol
      AND bucket.market_key = primary.valuation_market_key) AS low_fdv_usd,
    (array_agg(bucket.close_fdv_usd ORDER BY bucket.last_block_number DESC,
      bucket.last_log_index DESC, bucket.protocol DESC, bucket.market_key DESC) FILTER (WHERE
        bucket.protocol = primary.valuation_protocol
        AND bucket.market_key = primary.valuation_market_key))[1] AS close_fdv_usd,
    primary.valuation_protocol, primary.valuation_market_key,
    primary.valuation_volume_24h_usd,
    SUM(bucket.volume_usd) AS volume_usd, SUM(bucket.swaps)::bigint AS swaps,
    SUM(bucket.buys)::bigint AS buys, SUM(bucket.sells)::bigint AS sells,
    SUM(bucket.transactions)::bigint AS transactions,
    COUNT(DISTINCT (bucket.protocol, bucket.market_key))::int AS market_count,
    ARRAY_AGG(DISTINCT bucket.protocol::text ORDER BY bucket.protocol::text) AS protocols,
    ${source.minutes}::smallint AS source_granularity_minutes,
    COUNT(*)::int AS source_bucket_count,
    (array_agg(bucket.first_observed_at ORDER BY bucket.first_block_number,
      bucket.first_log_index, bucket.protocol, bucket.market_key))[1] AS first_observed_at,
    MIN(bucket.first_block_number) AS first_block_number,
    (array_agg(bucket.first_log_index ORDER BY bucket.first_block_number,
      bucket.first_log_index, bucket.protocol, bucket.market_key))[1] AS first_log_index,
    (array_agg(bucket.last_observed_at ORDER BY bucket.last_block_number DESC,
      bucket.last_log_index DESC, bucket.protocol DESC, bucket.market_key DESC))[1]
      AS last_observed_at,
    MAX(bucket.last_block_number) AS last_block_number,
    (array_agg(bucket.last_log_index ORDER BY bucket.last_block_number DESC,
      bucket.last_log_index DESC, bucket.protocol DESC, bucket.market_key DESC))[1]
      AS last_log_index
  FROM source_buckets bucket
  INNER JOIN primary_markets primary
    ON primary.token_address = bucket.token_address
   AND primary.aggregate_bucket_ts = bucket.aggregate_bucket_ts
  GROUP BY bucket.token_address, bucket.aggregate_bucket_ts,
    primary.valuation_protocol, primary.valuation_market_key,
    primary.valuation_volume_24h_usd`;
  const actual = `SELECT ${AGGREGATE_FIELDS.join(', ')}
  FROM robinhood_market_buckets_agg
  WHERE chain = 'robinhood' AND token_address = ANY($1)
    AND granularity_minutes = ${granularityMinutes}
    AND bucket_ts >= $2 AND bucket_ts < $3`;
  const identity = `expected.token_address = actual.token_address
    AND expected.granularity_minutes = actual.granularity_minutes
    AND expected.bucket_ts = actual.bucket_ts`;
  return summarySql(expected, actual, identity, AGGREGATE_FIELDS);
}

function defaultBounds(now = new Date()) {
  const to = new Date(now);
  to.setUTCHours(0, 0, 0, 0);
  return {
    from: new Date(to.getTime() - DEFAULT_DAYS * 86_400_000).toISOString(),
    to: to.toISOString(),
  };
}

function readCliValues(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith('--') || argv[index + 1] == null) {
      throw new TypeError(`Invalid argument: ${argv[index]}`);
    }
    values[argv[index].slice(2)] = argv[index + 1];
  }
  return values;
}

function normalizeAfterToken(value) {
  if (!value) return null;
  const token = value.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(token)) throw new TypeError('after-token is invalid');
  return token;
}

function parseCliArgs(argv, now = new Date()) {
  const values = readCliValues(argv);
  const defaults = defaultBounds(now);
  const from = new Date(values.from || defaults.from);
  const to = new Date(values.to || defaults.to);
  const afterToken = normalizeAfterToken(values['after-token']);
  const tokenLimit = Number(values['token-limit'] || 25);
  const statementTimeoutMs = Number(values['statement-timeout-ms'] || 10_000);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
    throw new TypeError('Audit bounds are invalid');
  }
  if (from.getTime() % 86_400_000 || to.getTime() % 86_400_000) {
    throw new TypeError('Audit bounds must be aligned to UTC days');
  }
  if (!Number.isInteger(tokenLimit) || tokenLimit < 1 || tokenLimit > 250) {
    throw new TypeError('token-limit must be between 1 and 250');
  }
  if (!Number.isInteger(statementTimeoutMs) || statementTimeoutMs < 1000) {
    throw new TypeError('statement-timeout-ms must be at least 1000');
  }
  return {
    from: from.toISOString(), to: to.toISOString(), afterToken,
    tokenLimit, statementTimeoutMs,
  };
}

function query(database, sql, params, timeoutMs) {
  if (typeof database.queryWithStatementTimeout === 'function') {
    return database.queryWithStatementTimeout(sql, params, timeoutMs);
  }
  return database.query(sql, params);
}

async function auditQuery(database, label, sql, params, timeoutMs) {
  try {
    return await query(database, sql, params, timeoutMs);
  } catch (error) {
    throw new Error(`${label} failed: ${error.message}`, { cause: error });
  }
}

function normalizeRows(rows, level, granularityMinutes) {
  return rows.map((row) => {
    const missing = Number(row.missing_buckets || 0);
    const orphan = Number(row.orphan_buckets || 0);
    const divergent = Number(row.divergent_buckets || 0);
    return {
      level, tokenAddress: row.token_address, granularityMinutes,
      matchedBuckets: Number(row.matched_buckets || 0),
      missingBuckets: missing, orphanBuckets: orphan, divergentBuckets: divergent,
      complete: missing + orphan + divergent === 0,
      firstMismatchAt: row.first_mismatch_at
        ? new Date(row.first_mismatch_at).toISOString() : null,
      watermark: new Date(row.watermark).toISOString(),
    };
  });
}

async function runAudit(options, deps = {}) {
  const database = deps.database || db;
  const page = await auditQuery(database, 'token page', TOKEN_PAGE_SQL, [
    options.from, options.to, options.afterToken, options.tokenLimit,
  ], options.statementTimeoutMs);
  const tokens = page.rows.slice(0, options.tokenLimit).map((row) => row.token_address);
  if (!tokens.length) {
    return {
      ...options, tokens: 0, pageComplete: true, pageWatermark: options.to, results: [],
    };
  }
  const params = [tokens, options.from, options.to];
  const hourly = await auditQuery(
    database, 'hourly coverage', buildHourlyAuditSql(), params, options.statementTimeoutMs
  );
  const results = normalizeRows(hourly.rows, 'hourly', 60);
  for (const granularity of GRANULARITIES) {
    const audited = await auditQuery(
      database, `aggregate ${granularity}m coverage`,
      buildAggregateAuditSql(granularity), params, options.statementTimeoutMs
    );
    results.push(...normalizeRows(audited.rows, 'aggregate', granularity));
  }
  const watermark = results.reduce(
    (minimum, result) => result.watermark < minimum ? result.watermark : minimum,
    options.to
  );
  return {
    ...options, tokens: tokens.length,
    nextAfterToken: page.rows.length > options.tokenLimit ? tokens.at(-1) : null,
    pageComplete: results.every((result) => result.complete),
    pageWatermark: watermark, results,
  };
}

if (require.main === module) {
  const options = parseCliArgs(process.argv.slice(2));
  runAudit(options).then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(`[RobinhoodAggregateCoverageAudit] ${error.message}`);
      process.exitCode = 1;
    }).finally(() => db.pool.end());
}

module.exports = {
  runAudit,
  __private: {
    AGGREGATE_FIELDS, GRANULARITIES, HOURLY_FIELDS, TOKEN_PAGE_SQL,
    buildAggregateAuditSql, buildHourlyAuditSql, defaultBounds, parseCliArgs, readCliValues,
  },
};
