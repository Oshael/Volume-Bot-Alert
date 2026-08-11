const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const MAX_BATCH_SIZE = 500;
const MAX_HISTORY_DAYS = 90;

function holderCount(value) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error('holderCount must be a non-negative integer');
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) throw new Error('holderCount exceeds safe integer range');
  return parsed;
}

function timestamp(value, label, nullable = false) {
  if (nullable && value == null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be a valid timestamp`);
  return parsed.toISOString();
}

function errorCode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9_:-]{1,64}$/.test(normalized)) throw new Error('errorCode is invalid');
  return normalized;
}

function addressBatch(values) {
  if (!Array.isArray(values)) throw new TypeError('tokenAddresses must be an array');
  if (values.length > MAX_BATCH_SIZE) throw new RangeError(`tokenAddresses exceeds ${MAX_BATCH_SIZE}`);
  return [...new Set(values.map((value) => normalizeTokenAddress(CHAIN, value)))];
}

function normalizeSummaryRow(row, allowLive = false) {
  if (!row) throw new Error('Holder summary write returned no row');
  const failures = Number(row.consecutive_failures);
  if (!Number.isSafeInteger(failures) || failures < 0) {
    throw new Error('Holder summary consecutive failures are invalid');
  }
  if (row.source !== 'blockscout' && !(allowLive && row.source === 'ledger_live')) {
    throw new Error('Holder summary source is invalid');
  }
  return Object.freeze({
    tokenAddress: normalizeTokenAddress(CHAIN, row.token_address),
    holderCount: row.holder_count == null ? null : holderCount(row.holder_count),
    source: row.source,
    observedAt: timestamp(row.observed_at, 'observedAt', true),
    checkedAt: timestamp(row.checked_at, 'checkedAt'),
    lastErrorCode: row.last_error_code == null ? null : errorCode(row.last_error_code),
    consecutiveFailures: failures,
    retryAfterAt: timestamp(row.retry_after_at, 'retryAfterAt', true),
  });
}

function historyDays(value) {
  const parsed = Number(value ?? 30);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_HISTORY_DAYS) {
    throw new RangeError(`days must be between 1 and ${MAX_HISTORY_DAYS}`);
  }
  return parsed;
}

function normalizeSnapshotDate(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('snapshot date is invalid');
  return parsed.toISOString().slice(0, 10);
}

function normalizeDailySnapshotRow(row) {
  return Object.freeze({
    date: normalizeSnapshotDate(row.snapshot_date),
    holderCount: holderCount(row.holder_count),
    observedAt: timestamp(row.observed_at, 'snapshot observedAt'),
  });
}

function createRobinhoodTokenHolderSummaryRepository(options = {}) {
  const database = options.database || db;

  async function listRefreshCandidates(input = {}) {
    const asOf = timestamp(input.asOf || new Date(), 'asOf');
    const hotWindowMs = Number(input.hotWindowMs);
    const hotRefreshMs = Number(input.hotRefreshMs);
    const coldRefreshMs = Number(input.coldRefreshMs);
    const limit = Number(input.limit);
    const coldQuota = Number(input.coldQuota);
    for (const [label, value] of Object.entries({ hotWindowMs, hotRefreshMs, coldRefreshMs })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} is invalid`);
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new RangeError('limit must be between 1 and 50');
    }
    if (!Number.isSafeInteger(coldQuota) || coldQuota < 1 || coldQuota >= limit) {
      throw new RangeError('coldQuota must be smaller than limit');
    }
    const { rows } = await database.query(
      `WITH due AS (
       SELECT catalog.address AS token_address,
              CASE WHEN catalog.last_seen_at >= $2::timestamptz
                THEN 'hot' ELSE 'cold' END AS priority,
              COALESCE(summary.consecutive_failures, 0) AS consecutive_failures,
              summary.checked_at
       FROM token_catalog catalog
       LEFT JOIN robinhood_token_holder_summaries summary
         ON summary.chain = catalog.chain AND summary.token_address = catalog.address
       WHERE catalog.chain = '${CHAIN}'
         AND (summary.retry_after_at IS NULL OR summary.retry_after_at <= $1::timestamptz)
         AND (summary.checked_at IS NULL OR summary.checked_at <= CASE
           WHEN catalog.last_seen_at >= $2::timestamptz THEN $3::timestamptz
           ELSE $4::timestamptz END)
     ), ranked AS (
       SELECT due.*,
              ROW_NUMBER() OVER (
                PARTITION BY priority ORDER BY checked_at ASC NULLS FIRST, token_address ASC
              ) AS priority_rank
       FROM due
     )
       SELECT token_address, priority, consecutive_failures
       FROM ranked
       ORDER BY CASE WHEN priority = 'hot'
         THEN priority_rank::numeric / ($5::int - $6::int)
         ELSE priority_rank::numeric / $6::int END,
         CASE WHEN priority = 'hot' THEN 0 ELSE 1 END, token_address ASC
       LIMIT $5::int`,
      [
        asOf,
        new Date(Date.parse(asOf) - hotWindowMs).toISOString(),
        new Date(Date.parse(asOf) - hotRefreshMs).toISOString(),
        new Date(Date.parse(asOf) - coldRefreshMs).toISOString(),
        limit,
        coldQuota,
      ]
    );
    return rows.map((row) => Object.freeze({
      tokenAddress: normalizeTokenAddress(CHAIN, row.token_address),
      priority: row.priority === 'hot' ? 'hot' : 'cold',
      consecutiveFailures: Number(row.consecutive_failures) || 0,
    }));
  }

  async function recordSuccess(input = {}) {
    const tokenAddress = normalizeTokenAddress(CHAIN, input.tokenAddress);
    const count = holderCount(input.holderCount);
    const observedAt = timestamp(input.observedAt, 'observedAt');
    const { rows } = await database.query(
      `WITH saved_summary AS (
       INSERT INTO robinhood_token_holder_summaries (
         chain, token_address, holder_count, source, observed_at,
         checked_at, last_error_code, consecutive_failures, retry_after_at
       ) VALUES ('${CHAIN}', $1, $2::bigint, 'blockscout', $3::timestamptz,
                 NOW(), NULL, 0, NULL)
       ON CONFLICT (chain, token_address) DO UPDATE SET
         holder_count = CASE
           WHEN robinhood_token_holder_summaries.observed_at IS NULL
             OR EXCLUDED.observed_at >= robinhood_token_holder_summaries.observed_at
           THEN EXCLUDED.holder_count ELSE robinhood_token_holder_summaries.holder_count
         END,
         observed_at = GREATEST(
           robinhood_token_holder_summaries.observed_at, EXCLUDED.observed_at
         ),
         checked_at = GREATEST(robinhood_token_holder_summaries.checked_at, EXCLUDED.checked_at),
         last_error_code = CASE
           WHEN robinhood_token_holder_summaries.observed_at IS NULL
             OR EXCLUDED.observed_at >= robinhood_token_holder_summaries.observed_at
           THEN NULL ELSE robinhood_token_holder_summaries.last_error_code
         END,
         consecutive_failures = CASE
           WHEN robinhood_token_holder_summaries.observed_at IS NULL
             OR EXCLUDED.observed_at >= robinhood_token_holder_summaries.observed_at
           THEN 0 ELSE robinhood_token_holder_summaries.consecutive_failures
         END,
         retry_after_at = CASE
           WHEN robinhood_token_holder_summaries.observed_at IS NULL
             OR EXCLUDED.observed_at >= robinhood_token_holder_summaries.observed_at
           THEN NULL ELSE robinhood_token_holder_summaries.retry_after_at
         END,
         updated_at = NOW()
       RETURNING *
     ), saved_daily AS (
       INSERT INTO robinhood_token_holder_daily_snapshots (
         chain, token_address, snapshot_date, holder_count, source, observed_at
       )
       SELECT chain, token_address, (observed_at AT TIME ZONE 'UTC')::date,
              holder_count, source, observed_at
       FROM saved_summary
       WHERE observed_at = $3::timestamptz
       ON CONFLICT (chain, token_address, snapshot_date) DO UPDATE SET
         holder_count = EXCLUDED.holder_count,
         source = EXCLUDED.source,
         observed_at = EXCLUDED.observed_at,
         updated_at = NOW()
       WHERE EXCLUDED.observed_at >=
         robinhood_token_holder_daily_snapshots.observed_at
         AND robinhood_token_holder_daily_snapshots.source <> 'ledger_live'
       RETURNING 1
     )
       SELECT * FROM saved_summary`,
      [tokenAddress, String(count), observedAt]
    );
    return normalizeSummaryRow(rows[0]);
  }

  async function recordFailure(input = {}) {
    const tokenAddress = normalizeTokenAddress(CHAIN, input.tokenAddress);
    const normalizedErrorCode = errorCode(input.errorCode);
    const retryAfterAt = timestamp(input.retryAfterAt, 'retryAfterAt', true);
    const { rows } = await database.query(
      `INSERT INTO robinhood_token_holder_summaries (
         chain, token_address, holder_count, source, observed_at,
         checked_at, last_error_code, consecutive_failures, retry_after_at
       ) VALUES ('${CHAIN}', $1, NULL, 'blockscout', NULL,
                 NOW(), $2, 1, $3::timestamptz)
       ON CONFLICT (chain, token_address) DO UPDATE SET
         checked_at = NOW(),
         last_error_code = EXCLUDED.last_error_code,
         consecutive_failures = LEAST(
           robinhood_token_holder_summaries.consecutive_failures::bigint + 1,
           2147483647
         )::integer,
         retry_after_at = EXCLUDED.retry_after_at,
         updated_at = NOW()
       RETURNING *`,
      [tokenAddress, normalizedErrorCode, retryAfterAt]
    );
    return normalizeSummaryRow(rows[0]);
  }

  async function getSummaries(tokenAddresses) {
    const addresses = addressBatch(tokenAddresses);
    if (addresses.length === 0) return [];
    const { rows } = await database.query(
      `SELECT token_address, holder_count, source, observed_at, checked_at,
              last_error_code, consecutive_failures, retry_after_at
       FROM robinhood_token_holder_summaries
       WHERE chain = '${CHAIN}' AND token_address = ANY($1::varchar[])
       ORDER BY token_address ASC`,
      [addresses]
    );
    return rows.map(normalizeSummaryRow);
  }

  async function getPublishedSummaries(tokenAddresses) {
    const addresses = addressBatch(tokenAddresses);
    if (addresses.length === 0) return [];
    const { rows } = await database.query(
      `SELECT token_address, holder_count, source, observed_at, checked_at,
              last_error_code, consecutive_failures, retry_after_at
       FROM robinhood_published_holder_summaries
       WHERE chain = '${CHAIN}' AND token_address = ANY($1::varchar[])
       ORDER BY token_address ASC`,
      [addresses]
    );
    return rows.map((row) => normalizeSummaryRow(row, true));
  }

  async function syncLiveDailySnapshots(input = {}) {
    const asOf = timestamp(input.asOf || new Date(), 'snapshot asOf');
    const limit = Number(input.limit ?? 500);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) {
      throw new RangeError('snapshot limit must be between 1 and 5000');
    }
    const { rows } = await database.query(
      `WITH candidates AS MATERIALIZED (
         SELECT published.chain, published.token_address, published.holder_count
           FROM robinhood_published_holder_summaries published
           LEFT JOIN robinhood_token_holder_daily_snapshots snapshot
             ON snapshot.chain = published.chain
            AND snapshot.token_address = published.token_address
            AND snapshot.snapshot_date = ($1::timestamptz AT TIME ZONE 'UTC')::date
          WHERE published.source = 'ledger_live'
            AND (snapshot.token_address IS NULL OR snapshot.source <> 'ledger_live'
              OR snapshot.observed_at < published.observed_at)
          ORDER BY snapshot.observed_at ASC NULLS FIRST, published.token_address ASC
          LIMIT $2::int
       ), saved AS (
         INSERT INTO robinhood_token_holder_daily_snapshots (
           chain, token_address, snapshot_date, holder_count, source, observed_at
         )
         SELECT chain, token_address, ($1::timestamptz AT TIME ZONE 'UTC')::date,
                holder_count, 'ledger_live', $1::timestamptz
           FROM candidates
         ON CONFLICT (chain, token_address, snapshot_date) DO UPDATE SET
           holder_count = EXCLUDED.holder_count, source = EXCLUDED.source,
           observed_at = EXCLUDED.observed_at, updated_at = NOW()
         WHERE robinhood_token_holder_daily_snapshots.source <> 'ledger_live'
            OR EXCLUDED.observed_at >= robinhood_token_holder_daily_snapshots.observed_at
         RETURNING 1
       )
       SELECT COUNT(*)::int AS saved_count FROM saved`,
      [asOf, limit]
    );
    return Object.freeze({ savedCount: Number(rows[0]?.saved_count) || 0, asOf });
  }

  async function listDailySnapshots(input = {}) {
    const tokenAddress = normalizeTokenAddress(CHAIN, input.tokenAddress);
    const days = historyDays(input.days);
    const asOf = timestamp(input.asOf || new Date(), 'history asOf');
    const { rows } = await database.query(
      `SELECT snapshot_date, holder_count, observed_at
       FROM (
         SELECT snapshot_date, holder_count, observed_at
         FROM robinhood_token_holder_daily_snapshots
         WHERE chain = '${CHAIN}' AND token_address = $1
           AND snapshot_date <= ($2::timestamptz AT TIME ZONE 'UTC')::date
         ORDER BY snapshot_date DESC
         LIMIT $3::int
       ) recent
       ORDER BY snapshot_date ASC`,
      [tokenAddress, asOf, days + 1]
    );
    return rows.map(normalizeDailySnapshotRow);
  }

  return Object.freeze({
    listRefreshCandidates, recordSuccess, recordFailure, getSummaries,
    getPublishedSummaries, syncLiveDailySnapshots, listDailySnapshots,
  });
}

module.exports = {
  createRobinhoodTokenHolderSummaryRepository,
  __private: {
    addressBatch, errorCode, historyDays, holderCount,
    normalizeDailySnapshotRow, normalizeSummaryRow,
  },
};
