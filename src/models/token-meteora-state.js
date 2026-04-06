const db = require('./db');
const { isValidAddress } = require('./user-token');

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeAddress(address) {
  const value = String(address || '').trim();
  if (!isValidAddress(value)) {
    throw new Error('Invalid token address format');
  }
  return value;
}

function normalizeAddressList(addresses) {
  const normalized = [...new Set((addresses || []).map((address) => String(address || '').trim()).filter(Boolean))];
  for (const address of normalized) {
    if (!isValidAddress(address)) {
      throw new Error('Invalid token address format');
    }
  }
  return normalized;
}

function toTimestampOrNull(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function normalizeError(value) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, 1000) : null;
}

function normalizeSource(value) {
  const normalized = String(value || 'meteora').trim().toLowerCase();
  return normalized || 'meteora';
}

function mapStateRow(row) {
  if (!row) return null;
  return {
    tokenAddress: row.token_address || null,
    lastCheckedAt: row.last_checked_at || null,
    hasPool: row.has_pool == null ? null : Boolean(row.has_pool),
    currentTvl: toNumberOrNull(row.current_tvl),
    bestPoolAddress: row.best_pool_address || null,
    poolCount: Number(row.pool_count) || 0,
    lastError: normalizeError(row.last_error),
    source: row.source || 'meteora',
    updatedAt: row.updated_at || null,
  };
}

function mapSummaryRow(row) {
  if (!row) return null;
  return {
    tokenAddress: row.token_address || null,
    lastCheckedAt: row.last_checked_at || null,
    hasPool: row.has_pool == null ? null : Boolean(row.has_pool),
    currentTvl: toNumberOrNull(row.current_tvl),
    bestPoolAddress: row.best_pool_address || null,
    poolCount: Number(row.pool_count) || 0,
    lastError: normalizeError(row.last_error),
    source: row.source || 'meteora',
    lastSnapshotAt: row.last_snapshot_at || null,
    baselineTvl1h: toNumberOrNull(row.baseline_tvl_1h),
    baselineTvl6h: toNumberOrNull(row.baseline_tvl_6h),
    baselineTvl24h: toNumberOrNull(row.baseline_tvl_24h),
    updatedAt: row.updated_at || null,
  };
}

async function getState(address, runner = db) {
  const normalized = normalizeAddress(address);
  const { rows } = await runner.query(
    `SELECT *
     FROM token_meteora_state
     WHERE token_address = $1
     LIMIT 1`,
    [normalized]
  );
  return mapStateRow(rows[0] || null);
}

async function upsertState(payload = {}, runner = db) {
  const tokenAddress = normalizeAddress(payload.tokenAddress || payload.address);
  const lastCheckedAt = toTimestampOrNull(payload.lastCheckedAt);
  const hasPool = payload.hasPool == null ? null : Boolean(payload.hasPool);
  const currentTvl = toNumberOrNull(payload.currentTvl ?? payload.tvl);
  const bestPoolAddress = payload.bestPoolAddress || payload.poolAddress || null;
  const poolCount = Math.max(0, Math.floor(Number(payload.poolCount) || 0));
  const lastError = normalizeError(payload.lastError);
  const source = normalizeSource(payload.source);

  const { rows } = await runner.query(
    `INSERT INTO token_meteora_state (
       token_address,
       last_checked_at,
       has_pool,
       current_tvl,
       best_pool_address,
       pool_count,
       last_error,
       source,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (token_address) DO UPDATE SET
       last_checked_at = EXCLUDED.last_checked_at,
       has_pool = EXCLUDED.has_pool,
       current_tvl = EXCLUDED.current_tvl,
       best_pool_address = EXCLUDED.best_pool_address,
       pool_count = EXCLUDED.pool_count,
       last_error = EXCLUDED.last_error,
       source = EXCLUDED.source,
       updated_at = NOW()
     RETURNING *`,
    [
      tokenAddress,
      lastCheckedAt,
      hasPool,
      currentTvl,
      bestPoolAddress,
      poolCount,
      lastError,
      source,
    ]
  );

  return mapStateRow(rows[0] || null);
}

async function recordError(address, error, runner = db) {
  const tokenAddress = normalizeAddress(address);
  const lastError = normalizeError(error);

  const { rows } = await runner.query(
    `INSERT INTO token_meteora_state (
       token_address,
       last_checked_at,
       has_pool,
       current_tvl,
       best_pool_address,
       pool_count,
       last_error,
       source,
       updated_at
     )
     VALUES ($1, NULL, NULL, NULL, NULL, 0, $2, 'meteora', NOW())
     ON CONFLICT (token_address) DO UPDATE SET
       last_error = EXCLUDED.last_error,
       updated_at = NOW()
     RETURNING *`,
    [tokenAddress, lastError]
  );

  return mapStateRow(rows[0] || null);
}

async function listSummaryByAddresses(addresses, runner = db) {
  const normalized = normalizeAddressList(addresses);
  if (normalized.length === 0) {
    return [];
  }

  const { rows } = await runner.query(
    `WITH state AS (
       SELECT
         token_address,
         last_checked_at,
         has_pool,
         current_tvl,
         best_pool_address,
         pool_count,
         last_error,
         source,
         updated_at
       FROM token_meteora_state
       WHERE token_address = ANY($1::varchar[])
     ),
     latest_snapshot AS (
       SELECT DISTINCT ON (token_address)
         token_address,
         ts AS last_snapshot_at
       FROM token_meteora_snapshots
       WHERE token_address = ANY($1::varchar[])
         AND total_tvl IS NOT NULL
         AND total_tvl > 0
       ORDER BY token_address, ts DESC
     )
     SELECT
       state.token_address,
       state.last_checked_at,
       state.has_pool,
       state.current_tvl,
       state.best_pool_address,
       state.pool_count,
       state.last_error,
       state.source,
       state.updated_at,
       latest_snapshot.last_snapshot_at,
       CASE
         WHEN state.has_pool IS TRUE AND state.current_tvl IS NOT NULL
           THEN COALESCE(before_1h.total_tvl, after_1h.total_tvl)
         ELSE NULL
       END AS baseline_tvl_1h,
       CASE
         WHEN state.has_pool IS TRUE AND state.current_tvl IS NOT NULL
           THEN COALESCE(before_6h.total_tvl, after_6h.total_tvl)
         ELSE NULL
       END AS baseline_tvl_6h,
       CASE
         WHEN state.has_pool IS TRUE AND state.current_tvl IS NOT NULL
           THEN COALESCE(before_24h.total_tvl, after_24h.total_tvl)
         ELSE NULL
       END AS baseline_tvl_24h
     FROM state
     LEFT JOIN latest_snapshot
       ON latest_snapshot.token_address = state.token_address
     LEFT JOIN LATERAL (
       SELECT total_tvl
       FROM token_meteora_snapshots
       WHERE token_address = state.token_address
         AND total_tvl IS NOT NULL
         AND total_tvl > 0
         AND state.last_checked_at IS NOT NULL
         AND ts <= state.last_checked_at - INTERVAL '1 hour'
       ORDER BY ts DESC
       LIMIT 1
     ) AS before_1h ON TRUE
     LEFT JOIN LATERAL (
       SELECT total_tvl
       FROM token_meteora_snapshots
       WHERE token_address = state.token_address
         AND total_tvl IS NOT NULL
         AND total_tvl > 0
         AND state.last_checked_at IS NOT NULL
         AND ts > state.last_checked_at - INTERVAL '1 hour'
       ORDER BY ts ASC
       LIMIT 1
     ) AS after_1h ON TRUE
     LEFT JOIN LATERAL (
       SELECT total_tvl
       FROM token_meteora_snapshots
       WHERE token_address = state.token_address
         AND total_tvl IS NOT NULL
         AND total_tvl > 0
         AND state.last_checked_at IS NOT NULL
         AND ts <= state.last_checked_at - INTERVAL '6 hour'
       ORDER BY ts DESC
       LIMIT 1
     ) AS before_6h ON TRUE
     LEFT JOIN LATERAL (
       SELECT total_tvl
       FROM token_meteora_snapshots
       WHERE token_address = state.token_address
         AND total_tvl IS NOT NULL
         AND total_tvl > 0
         AND state.last_checked_at IS NOT NULL
         AND ts > state.last_checked_at - INTERVAL '6 hour'
       ORDER BY ts ASC
       LIMIT 1
     ) AS after_6h ON TRUE
     LEFT JOIN LATERAL (
       SELECT total_tvl
       FROM token_meteora_snapshots
       WHERE token_address = state.token_address
         AND total_tvl IS NOT NULL
         AND total_tvl > 0
         AND state.last_checked_at IS NOT NULL
         AND ts <= state.last_checked_at - INTERVAL '24 hour'
       ORDER BY ts DESC
       LIMIT 1
     ) AS before_24h ON TRUE
     LEFT JOIN LATERAL (
       SELECT total_tvl
       FROM token_meteora_snapshots
       WHERE token_address = state.token_address
         AND total_tvl IS NOT NULL
         AND total_tvl > 0
         AND state.last_checked_at IS NOT NULL
         AND ts > state.last_checked_at - INTERVAL '24 hour'
       ORDER BY ts ASC
       LIMIT 1
     ) AS after_24h ON TRUE
     ORDER BY state.token_address ASC`,
    [normalized]
  );

  return rows.map(mapSummaryRow);
}

async function getSummaryByAddress(address, runner = db) {
  const normalized = normalizeAddress(address);
  const rows = await listSummaryByAddresses([normalized], runner);
  return rows[0] || null;
}

module.exports = {
  getState,
  getSummaryByAddress,
  listSummaryByAddresses,
  recordError,
  upsertState,
  __private: {
    mapStateRow,
    mapSummaryRow,
    normalizeAddress,
    normalizeAddressList,
    normalizeError,
    normalizeSource,
    toNumberOrNull,
    toTimestampOrNull,
  },
};
