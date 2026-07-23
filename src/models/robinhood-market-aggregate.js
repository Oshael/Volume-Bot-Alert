const db = require('./db');

const GRANULARITY_SOURCE = Object.freeze(new Map([
  [5, { minutes: 1, table: 'robinhood_market_buckets_1m' }],
  [15, { minutes: 1, table: 'robinhood_market_buckets_1m' }],
  [30, { minutes: 1, table: 'robinhood_market_buckets_1m' }],
  [60, { minutes: 60, table: 'robinhood_market_buckets_1h' }],
  [240, { minutes: 60, table: 'robinhood_market_buckets_1h' }],
  [1440, { minutes: 60, table: 'robinhood_market_buckets_1h' }],
]));

const AGGREGATE_COLUMN_TYPES = Object.freeze({
  chain: 'text', token_address: 'text', granularity_minutes: 'smallint',
  bucket_ts: 'timestamptz', open_price_usd: 'numeric', high_price_usd: 'numeric',
  low_price_usd: 'numeric', close_price_usd: 'numeric', open_fdv_usd: 'numeric',
  high_fdv_usd: 'numeric', low_fdv_usd: 'numeric', close_fdv_usd: 'numeric',
  volume_usd: 'numeric', swaps: 'bigint', buys: 'bigint', sells: 'bigint',
  transactions: 'bigint', market_count: 'integer', protocols: 'text[]',
  source_granularity_minutes: 'smallint', source_bucket_count: 'integer',
  first_observed_at: 'timestamptz', first_block_number: 'bigint',
  first_log_index: 'bigint', last_observed_at: 'timestamptz',
  last_block_number: 'bigint', last_log_index: 'bigint',
});
const AGGREGATE_COLUMNS = Object.freeze(Object.keys(AGGREGATE_COLUMN_TYPES));
const MUTABLE_COLUMNS = AGGREGATE_COLUMNS.filter((column) => (
  !['chain', 'token_address', 'granularity_minutes', 'bucket_ts'].includes(column)
));
const HOURLY_MUTABLE_COLUMNS = Object.freeze([
  'open_price_usd', 'high_price_usd', 'low_price_usd', 'close_price_usd',
  'open_fdv_usd', 'high_fdv_usd', 'low_fdv_usd', 'close_fdv_usd',
  'close_liquidity_usd', 'close_liquidity_raw', 'close_liquidity_status',
  'close_liquidity_confidence', 'close_liquidity_warning',
  'volume_usd', 'swaps', 'buys', 'sells', 'transactions', 'source_minute_buckets',
  'first_observed_at', 'first_block_number', 'first_log_index',
  'last_observed_at', 'last_block_number', 'last_log_index',
]);
const UPSERT_SQL = `INSERT INTO robinhood_market_buckets_agg (${AGGREGATE_COLUMNS.join(', ')})
  SELECT ${AGGREGATE_COLUMNS.join(', ')}
  FROM jsonb_to_record($1::jsonb) AS aggregate(
    ${AGGREGATE_COLUMNS.map((column) => `${column} ${AGGREGATE_COLUMN_TYPES[column]}`).join(', ')}
  )
  ON CONFLICT (chain, token_address, granularity_minutes, bucket_ts) DO UPDATE SET
    ${MUTABLE_COLUMNS.map((column) => `${column} = EXCLUDED.${column}`).join(', ')},
    updated_at = NOW()
  WHERE ${MUTABLE_COLUMNS.map((column) => (
    `robinhood_market_buckets_agg.${column} IS DISTINCT FROM EXCLUDED.${column}`
  )).join(' OR ')}
  RETURNING *`;
const HOURLY_REFRESH_SQL = `WITH candidate_tokens AS MATERIALIZED (
    SELECT token_address
    FROM robinhood_market_buckets_1m
    WHERE chain = 'robinhood'
      AND bucket_ts >= $1::timestamptz
      AND bucket_ts < $2::timestamptz
      AND ($3::text IS NULL OR token_address > $3::text)
    GROUP BY token_address
    ORDER BY token_address ASC
    LIMIT ($4::int + 1)
  ),
  page_tokens AS MATERIALIZED (
    SELECT token_address
    FROM candidate_tokens
    ORDER BY token_address ASC
    LIMIT $4::int
  ),
  aggregated AS MATERIALIZED (
    SELECT
      minute.chain, minute.protocol, minute.market_key,
      minute.token_address, minute.quote_address,
      date_trunc('hour', minute.bucket_ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        AS bucket_ts,
      (array_agg(minute.open_price_usd ORDER BY
        minute.first_block_number, minute.first_log_index))[1] AS open_price_usd,
      MAX(minute.high_price_usd) AS high_price_usd,
      MIN(minute.low_price_usd) AS low_price_usd,
      (array_agg(minute.close_price_usd ORDER BY
        minute.last_block_number DESC, minute.last_log_index DESC))[1] AS close_price_usd,
      (array_agg(minute.open_fdv_usd ORDER BY
        minute.first_block_number, minute.first_log_index))[1] AS open_fdv_usd,
      MAX(minute.high_fdv_usd) AS high_fdv_usd,
      MIN(minute.low_fdv_usd) AS low_fdv_usd,
      (array_agg(minute.close_fdv_usd ORDER BY
        minute.last_block_number DESC, minute.last_log_index DESC))[1] AS close_fdv_usd,
      (array_agg(minute.close_liquidity_usd ORDER BY
        minute.last_block_number DESC, minute.last_log_index DESC))[1] AS close_liquidity_usd,
      (array_agg(minute.close_liquidity_raw ORDER BY
        minute.last_block_number DESC, minute.last_log_index DESC))[1] AS close_liquidity_raw,
      (array_agg(minute.close_liquidity_status ORDER BY
        minute.last_block_number DESC, minute.last_log_index DESC))[1] AS close_liquidity_status,
      (array_agg(minute.close_liquidity_confidence ORDER BY
        minute.last_block_number DESC, minute.last_log_index DESC))[1]
        AS close_liquidity_confidence,
      (array_agg(minute.close_liquidity_warning ORDER BY
        minute.last_block_number DESC, minute.last_log_index DESC))[1]
        AS close_liquidity_warning,
      SUM(minute.volume_usd) AS volume_usd,
      SUM(minute.swaps)::bigint AS swaps,
      SUM(minute.buys)::bigint AS buys,
      SUM(minute.sells)::bigint AS sells,
      SUM(minute.transactions)::bigint AS transactions,
      COUNT(*)::smallint AS source_minute_buckets,
      (array_agg(minute.first_observed_at ORDER BY
        minute.first_block_number, minute.first_log_index))[1] AS first_observed_at,
      MIN(minute.first_block_number) AS first_block_number,
      (array_agg(minute.first_log_index ORDER BY
        minute.first_block_number, minute.first_log_index))[1] AS first_log_index,
      (array_agg(minute.last_observed_at ORDER BY
        minute.last_block_number DESC, minute.last_log_index DESC))[1] AS last_observed_at,
      MAX(minute.last_block_number) AS last_block_number,
      (array_agg(minute.last_log_index ORDER BY
        minute.last_block_number DESC, minute.last_log_index DESC))[1] AS last_log_index
    FROM robinhood_market_buckets_1m minute
    INNER JOIN page_tokens token USING (token_address)
    WHERE minute.chain = 'robinhood'
      AND minute.bucket_ts >= $1::timestamptz
      AND minute.bucket_ts < $2::timestamptz
    GROUP BY minute.chain, minute.protocol, minute.market_key,
      minute.token_address, minute.quote_address,
      date_trunc('hour', minute.bucket_ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  ),
  identity_conflicts AS (
    SELECT COUNT(*)::int AS count
    FROM aggregated source
    INNER JOIN robinhood_market_buckets_1h existing
      USING (chain, protocol, market_key, bucket_ts)
    WHERE (existing.token_address, existing.quote_address)
      IS DISTINCT FROM (source.token_address, source.quote_address)
  ),
  upserted AS (
    INSERT INTO robinhood_market_buckets_1h (
      chain, protocol, market_key, token_address, quote_address, bucket_ts,
      ${HOURLY_MUTABLE_COLUMNS.join(', ')}
    )
    SELECT chain, protocol, market_key, token_address, quote_address, bucket_ts,
      ${HOURLY_MUTABLE_COLUMNS.join(', ')}
    FROM aggregated
    ON CONFLICT (chain, protocol, market_key, bucket_ts) DO UPDATE SET
      ${HOURLY_MUTABLE_COLUMNS.map((column) => `${column} = EXCLUDED.${column}`).join(', ')},
      updated_at = NOW()
    WHERE robinhood_market_buckets_1h.token_address = EXCLUDED.token_address
      AND robinhood_market_buckets_1h.quote_address = EXCLUDED.quote_address
      AND (${HOURLY_MUTABLE_COLUMNS.map((column) => (
    `robinhood_market_buckets_1h.${column} IS DISTINCT FROM EXCLUDED.${column}`
  )).join(' OR ')})
    RETURNING 1
  )
  SELECT
    (SELECT COUNT(*)::int FROM aggregated) AS source_buckets,
    (SELECT count FROM identity_conflicts) AS identity_conflicts,
    (SELECT COUNT(*)::int FROM upserted) AS written_buckets,
    (SELECT COUNT(*)::int FROM page_tokens) AS token_count,
    (SELECT MAX(token_address) FROM page_tokens) AS last_token,
    (SELECT COUNT(*) FROM candidate_tokens) > $4::int AS has_more_tokens`;

function buildAggregateRangeSql(source) {
  return `WITH candidate_tokens AS MATERIALIZED (
      SELECT token_address
      FROM ${source.table}
      WHERE chain = 'robinhood'
        AND bucket_ts >= $1::timestamptz
        AND bucket_ts < $2::timestamptz
        AND ($4::text IS NULL OR token_address > $4::text)
      GROUP BY token_address
      ORDER BY token_address ASC
      LIMIT ($5::int + 1)
    ),
    page_tokens AS MATERIALIZED (
      SELECT token_address
      FROM candidate_tokens
      ORDER BY token_address ASC
      LIMIT $5::int
    ),
    source_window AS MATERIALIZED (
      SELECT chain, token_address, bucket_ts
      FROM ${source.table} source
      INNER JOIN page_tokens token USING (token_address)
      WHERE source.chain = 'robinhood'
        AND source.bucket_ts >= $1::timestamptz
        AND source.bucket_ts < $2::timestamptz
    ),
    granularities AS (
      SELECT UNNEST($3::smallint[]) AS granularity_minutes
    ),
    targets AS MATERIALIZED (
      SELECT DISTINCT
        source.chain, source.token_address, granularity.granularity_minutes,
        date_bin(
          granularity.granularity_minutes * INTERVAL '1 minute',
          source.bucket_ts,
          TIMESTAMPTZ '1970-01-01 00:00:00+00'
        ) AS bucket_ts
      FROM source_window source
      CROSS JOIN granularities granularity
    ),
    aggregated AS MATERIALIZED (
      SELECT
        target.chain, target.token_address, target.granularity_minutes, target.bucket_ts,
        (array_agg(bucket.open_price_usd ORDER BY
          bucket.first_block_number, bucket.first_log_index,
          bucket.protocol, bucket.market_key))[1] AS open_price_usd,
        MAX(bucket.high_price_usd) AS high_price_usd,
        MIN(bucket.low_price_usd) AS low_price_usd,
        (array_agg(bucket.close_price_usd ORDER BY
          bucket.last_block_number DESC, bucket.last_log_index DESC,
          bucket.protocol DESC, bucket.market_key DESC))[1] AS close_price_usd,
        (array_agg(bucket.open_fdv_usd ORDER BY
          bucket.first_block_number, bucket.first_log_index,
          bucket.protocol, bucket.market_key))[1] AS open_fdv_usd,
        MAX(bucket.high_fdv_usd) AS high_fdv_usd,
        MIN(bucket.low_fdv_usd) AS low_fdv_usd,
        (array_agg(bucket.close_fdv_usd ORDER BY
          bucket.last_block_number DESC, bucket.last_log_index DESC,
          bucket.protocol DESC, bucket.market_key DESC))[1] AS close_fdv_usd,
        SUM(bucket.volume_usd) AS volume_usd,
        SUM(bucket.swaps)::bigint AS swaps,
        SUM(bucket.buys)::bigint AS buys,
        SUM(bucket.sells)::bigint AS sells,
        SUM(bucket.transactions)::bigint AS transactions,
        COUNT(DISTINCT (bucket.protocol, bucket.market_key))::int AS market_count,
        ARRAY_AGG(DISTINCT bucket.protocol ORDER BY bucket.protocol) AS protocols,
        ${source.minutes}::smallint AS source_granularity_minutes,
        COUNT(*)::int AS source_bucket_count,
        (array_agg(bucket.first_observed_at ORDER BY
          bucket.first_block_number, bucket.first_log_index,
          bucket.protocol, bucket.market_key))[1] AS first_observed_at,
        MIN(bucket.first_block_number) AS first_block_number,
        (array_agg(bucket.first_log_index ORDER BY
          bucket.first_block_number, bucket.first_log_index,
          bucket.protocol, bucket.market_key))[1] AS first_log_index,
        (array_agg(bucket.last_observed_at ORDER BY
          bucket.last_block_number DESC, bucket.last_log_index DESC,
          bucket.protocol DESC, bucket.market_key DESC))[1] AS last_observed_at,
        MAX(bucket.last_block_number) AS last_block_number,
        (array_agg(bucket.last_log_index ORDER BY
          bucket.last_block_number DESC, bucket.last_log_index DESC,
          bucket.protocol DESC, bucket.market_key DESC))[1] AS last_log_index
      FROM targets target
      INNER JOIN ${source.table} bucket
        ON bucket.chain = target.chain
       AND bucket.token_address = target.token_address
       AND bucket.bucket_ts >= target.bucket_ts
       AND bucket.bucket_ts < target.bucket_ts
         + (target.granularity_minutes * INTERVAL '1 minute')
      GROUP BY target.chain, target.token_address,
        target.granularity_minutes, target.bucket_ts
    ),
    upserted AS (
      INSERT INTO robinhood_market_buckets_agg (${AGGREGATE_COLUMNS.join(', ')})
      SELECT ${AGGREGATE_COLUMNS.join(', ')}
      FROM aggregated
      ON CONFLICT (chain, token_address, granularity_minutes, bucket_ts) DO UPDATE SET
        ${MUTABLE_COLUMNS.map((column) => `${column} = EXCLUDED.${column}`).join(', ')},
        updated_at = NOW()
      WHERE ${MUTABLE_COLUMNS.map((column) => (
    `robinhood_market_buckets_agg.${column} IS DISTINCT FROM EXCLUDED.${column}`
  )).join(' OR ')}
      RETURNING 1
    )
    SELECT
      (SELECT COUNT(*)::int FROM source_window) AS source_buckets,
      (SELECT COUNT(*)::int FROM targets) AS target_buckets,
      (SELECT COUNT(*)::int FROM upserted) AS written_buckets,
      (SELECT COUNT(*)::int FROM page_tokens) AS token_count,
      (SELECT MAX(token_address) FROM page_tokens) AS last_token,
      (SELECT COUNT(*) FROM candidate_tokens) > $5::int AS has_more_tokens`;
}

function normalizeRefreshInput(input = {}) {
  const tokenAddress = String(input.tokenAddress || '').trim().toLowerCase();
  const granularityMinutes = Number(input.granularityMinutes);
  const source = GRANULARITY_SOURCE.get(granularityMinutes);
  const bucketDate = new Date(input.bucketTs);
  if (!/^0x[0-9a-f]{40}$/.test(tokenAddress)) throw new TypeError('tokenAddress is invalid');
  if (!source) throw new TypeError('granularityMinutes is unsupported');
  if (!Number.isFinite(bucketDate.getTime())) throw new TypeError('bucketTs is invalid');
  if (bucketDate.getTime() % (granularityMinutes * 60_000) !== 0) {
    throw new TypeError('bucketTs is not aligned to granularityMinutes');
  }
  return {
    tokenAddress,
    granularityMinutes,
    bucketTs: bucketDate.toISOString(),
    source,
  };
}

function normalizeTokenPage(input) {
  const afterToken = input.afterToken == null
    ? null
    : String(input.afterToken).trim().toLowerCase();
  const tokenLimit = Number(input.tokenLimit);
  if (afterToken != null && !/^0x[0-9a-f]{40}$/.test(afterToken)) {
    throw new TypeError('afterToken is invalid');
  }
  if (!Number.isInteger(tokenLimit) || tokenLimit < 1 || tokenLimit > 1000) {
    throw new TypeError('tokenLimit must be between 1 and 1000');
  }
  return { afterToken, tokenLimit };
}

function normalizeAggregateRange(input = {}) {
  const from = new Date(input.from);
  const to = new Date(input.to);
  const granularities = [...new Set(
    (Array.isArray(input.granularities) ? input.granularities : [])
      .map((value) => Number(value))
  )].sort((left, right) => left - right);
  if (!Number.isFinite(from.getTime())) throw new TypeError('from is invalid');
  if (!Number.isFinite(to.getTime())) throw new TypeError('to is invalid');
  if (from >= to) throw new TypeError('from must be before to');
  if (!granularities.length) throw new TypeError('granularities are required');
  const sources = granularities.map((granularity) => GRANULARITY_SOURCE.get(granularity));
  if (sources.some((source) => !source)) throw new TypeError('granularities contain unsupported values');
  if (sources.some((source) => source.table !== sources[0].table)) {
    throw new TypeError('granularities must use the same source table');
  }
  const page = normalizeTokenPage(input);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    granularities,
    source: sources[0],
    ...page,
  };
}

function normalizeHourlyRange(input = {}) {
  const from = new Date(input.from);
  const to = new Date(input.to);
  if (!Number.isFinite(from.getTime())) throw new TypeError('from is invalid');
  if (!Number.isFinite(to.getTime())) throw new TypeError('to is invalid');
  if (from >= to) throw new TypeError('from must be before to');
  if (from.getTime() % 3_600_000 !== 0 || to.getTime() % 3_600_000 !== 0) {
    throw new TypeError('hourly range must be aligned to UTC hours');
  }
  return { from: from.toISOString(), to: to.toISOString(), ...normalizeTokenPage(input) };
}

function compareBoundary(left, right, prefix) {
  const blockDelta = BigInt(left[`${prefix}_block_number`]) - BigInt(right[`${prefix}_block_number`]);
  if (blockDelta !== 0n) return blockDelta < 0n ? -1 : 1;
  const logDelta = BigInt(left[`${prefix}_log_index`]) - BigInt(right[`${prefix}_log_index`]);
  if (logDelta !== 0n) return logDelta < 0n ? -1 : 1;
  return `${left.protocol}:${left.market_key}`.localeCompare(`${right.protocol}:${right.market_key}`);
}

function selectBoundary(rows, prefix, selectLast = false) {
  return rows.reduce((selected, row) => {
    const comparison = compareBoundary(row, selected, prefix);
    return selectLast ? (comparison > 0 ? row : selected) : (comparison < 0 ? row : selected);
  });
}

function getDecimalParts(value) {
  const [whole, fraction = ''] = String(value).split('.');
  return { units: BigInt(`${whole || '0'}${fraction}`), scale: fraction.length };
}

function sumDecimal(rows, field) {
  let total = { units: 0n, scale: 0 };
  for (const row of rows) {
    const value = getDecimalParts(row[field]);
    const scale = Math.max(total.scale, value.scale);
    total = {
      units: total.units * (10n ** BigInt(scale - total.scale))
        + value.units * (10n ** BigInt(scale - value.scale)),
      scale,
    };
  }
  if (total.scale === 0) return total.units.toString();
  const padded = total.units.toString().padStart(total.scale + 1, '0');
  return `${padded.slice(0, -total.scale)}.${padded.slice(-total.scale)}`.replace(/\.?0+$/, '');
}

function sumInteger(rows, field) {
  return rows.reduce((total, row) => total + BigInt(row[field]), 0n).toString();
}

function foldMarketRows(rows, input) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const first = selectBoundary(rows, 'first');
  const last = selectBoundary(rows, 'last', true);
  const numericValues = (field) => rows.map((row) => Number(row[field]));
  return {
    chain: 'robinhood',
    token_address: input.tokenAddress,
    granularity_minutes: input.granularityMinutes,
    bucket_ts: input.bucketTs,
    open_price_usd: Number(first.open_price_usd),
    high_price_usd: Math.max(...numericValues('high_price_usd')),
    low_price_usd: Math.min(...numericValues('low_price_usd')),
    close_price_usd: Number(last.close_price_usd),
    open_fdv_usd: Number(first.open_fdv_usd),
    high_fdv_usd: Math.max(...numericValues('high_fdv_usd')),
    low_fdv_usd: Math.min(...numericValues('low_fdv_usd')),
    close_fdv_usd: Number(last.close_fdv_usd),
    volume_usd: sumDecimal(rows, 'volume_usd'),
    swaps: sumInteger(rows, 'swaps'),
    buys: sumInteger(rows, 'buys'),
    sells: sumInteger(rows, 'sells'),
    transactions: sumInteger(rows, 'transactions'),
    market_count: new Set(rows.map((row) => `${row.protocol}:${row.market_key}`)).size,
    protocols: [...new Set(rows.map((row) => row.protocol))].sort(),
    source_granularity_minutes: input.source.minutes,
    source_bucket_count: rows.length,
    first_observed_at: first.first_observed_at,
    first_block_number: String(first.first_block_number),
    first_log_index: String(first.first_log_index),
    last_observed_at: last.last_observed_at,
    last_block_number: String(last.last_block_number),
    last_log_index: String(last.last_log_index),
  };
}

function createRobinhoodMarketAggregateRepository(database = db) {
  async function listRecentSourceBuckets(input = {}) {
    const since = new Date(input.since);
    const limit = Math.max(1, Math.min(1000, Math.trunc(Number(input.limit)) || 500));
    if (!Number.isFinite(since.getTime())) throw new TypeError('since is invalid');
    const result = await database.query(
      `SELECT token_address, bucket_ts
       FROM robinhood_market_buckets_1m
       WHERE chain = 'robinhood' AND bucket_ts >= $1::timestamptz
       GROUP BY token_address, bucket_ts
       ORDER BY bucket_ts DESC, token_address ASC
       LIMIT $2::int`,
      [since.toISOString(), limit]
    );
    return result.rows;
  }

  async function refreshBucket(rawInput) {
    const input = normalizeRefreshInput(rawInput);
    const sourceResult = await database.query(
      `SELECT protocol, market_key, open_price_usd, high_price_usd, low_price_usd,
              close_price_usd, open_fdv_usd, high_fdv_usd, low_fdv_usd,
              close_fdv_usd, volume_usd, swaps, buys, sells, transactions,
              first_observed_at, first_block_number, first_log_index,
              last_observed_at, last_block_number, last_log_index
       FROM ${input.source.table}
       WHERE chain = 'robinhood' AND token_address = $1
         AND bucket_ts >= $2::timestamptz
         AND bucket_ts < $2::timestamptz + ($3::int * INTERVAL '1 minute')`,
      [input.tokenAddress, input.bucketTs, input.granularityMinutes]
    );
    const aggregate = foldMarketRows(sourceResult.rows, input);
    if (!aggregate) {
      await database.query(
        `DELETE FROM robinhood_market_buckets_agg
         WHERE chain = 'robinhood' AND token_address = $1
           AND granularity_minutes = $2 AND bucket_ts = $3::timestamptz`,
        [input.tokenAddress, input.granularityMinutes, input.bucketTs]
      );
      return null;
    }
    const result = await database.query(UPSERT_SQL, [JSON.stringify(aggregate)]);
    return result.rows[0] || aggregate;
  }

  async function refreshHourlyRange(rawInput) {
    const input = normalizeHourlyRange(rawInput);
    const result = await database.query(HOURLY_REFRESH_SQL, [
      input.from, input.to, input.afterToken, input.tokenLimit,
    ]);
    const counts = result.rows[0] || {};
    const identityConflicts = Number(counts.identity_conflicts || 0);
    if (identityConflicts > 0) {
      throw new Error('Robinhood hourly range has conflicting token dimensions');
    }
    return {
      sourceBuckets: Number(counts.source_buckets || 0),
      writtenBuckets: Number(counts.written_buckets || 0),
      tokenCount: Number(counts.token_count || 0),
      lastToken: counts.last_token || null,
      hasMoreTokens: counts.has_more_tokens === true,
    };
  }

  async function refreshAggregateRange(rawInput) {
    const input = normalizeAggregateRange(rawInput);
    const sql = buildAggregateRangeSql(input.source);
    const result = await database.query(sql, [
      input.from, input.to, input.granularities, input.afterToken, input.tokenLimit,
    ]);
    const counts = result.rows[0] || {};
    return {
      sourceBuckets: Number(counts.source_buckets || 0),
      targetBuckets: Number(counts.target_buckets || 0),
      writtenBuckets: Number(counts.written_buckets || 0),
      tokenCount: Number(counts.token_count || 0),
      lastToken: counts.last_token || null,
      hasMoreTokens: counts.has_more_tokens === true,
    };
  }

  return Object.freeze({
    listRecentSourceBuckets,
    refreshAggregateRange,
    refreshBucket,
    refreshHourlyRange,
  });
}

module.exports = {
  createRobinhoodMarketAggregateRepository,
  __private: {
    foldMarketRows,
    buildAggregateRangeSql,
    HOURLY_REFRESH_SQL,
    normalizeAggregateRange,
    normalizeHourlyRange,
    normalizeTokenPage,
    normalizeRefreshInput,
    UPSERT_SQL,
  },
};
