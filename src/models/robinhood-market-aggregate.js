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

  return Object.freeze({ listRecentSourceBuckets, refreshBucket });
}

module.exports = {
  createRobinhoodMarketAggregateRepository,
  __private: { foldMarketRows, normalizeRefreshInput, UPSERT_SQL },
};
