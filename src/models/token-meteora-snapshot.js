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

function normalizeTimestamp(value) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error('Invalid Meteora snapshot baseline timestamp');
  }
  return parsed;
}

async function insertSnapshot(snapshot, runner = db) {
  const address = normalizeAddress(snapshot.tokenAddress || snapshot.address);

  const { rows } = await runner.query(
    `INSERT INTO token_meteora_snapshots (
       token_address, ts, total_tvl, best_pool_address, pool_count, source
     )
     VALUES ($1, COALESCE($2, NOW()), $3, $4, $5, $6)
     RETURNING *`,
    [
      address,
      snapshot.ts || null,
      toNumberOrNull(snapshot.totalTvl ?? snapshot.tvl),
      snapshot.bestPoolAddress || snapshot.poolAddress || null,
      Number.isInteger(snapshot.poolCount) ? snapshot.poolCount : Math.max(0, Math.floor(Number(snapshot.poolCount) || 0)),
      String(snapshot.source || 'meteora').trim().toLowerCase(),
    ]
  );

  return rows[0];
}

async function getLatestByAddresses(addresses) {
  const normalized = normalizeAddressList(addresses);
  if (normalized.length === 0) {
    return [];
  }

  const { rows } = await db.query(
    `SELECT DISTINCT ON (token_address)
       token_address, ts, total_tvl, best_pool_address, pool_count, source
     FROM token_meteora_snapshots
     WHERE token_address = ANY($1::varchar[])
     ORDER BY token_address, ts DESC`,
    [normalized]
  );

  return rows;
}

async function listHistoryByAddress(address, options = {}) {
  const normalized = normalizeAddress(address);
  const limit = Math.max(1, Math.min(Number(options.limit) || 168, 1000));
  const hours = options.hours == null ? null : Math.max(1, Math.min(Number(options.hours) || 0, 24 * 30));
  const days = options.days == null ? null : Math.max(1, Math.min(Number(options.days) || 0, 30));

  let lookbackHours = hours;
  if (lookbackHours == null && days != null) {
    lookbackHours = days * 24;
  }

  const params = [normalized, limit];
  let whereExtra = '';
  if (lookbackHours != null) {
    params.push(lookbackHours);
    whereExtra = `AND ts >= NOW() - ($3::int * INTERVAL '1 hour')`;
  }

  const { rows } = await db.query(
    `SELECT token_address, ts, total_tvl, best_pool_address, pool_count, source
     FROM token_meteora_snapshots
     WHERE token_address = $1
       ${whereExtra}
     ORDER BY ts DESC
     LIMIT $2`,
    params
  );

  return rows.reverse();
}

async function listHistoryByAddresses(addresses, options = {}) {
  const normalized = normalizeAddressList(addresses);
  if (normalized.length === 0) {
    return [];
  }

  const hours = Math.max(1, Math.min(Number(options.hours) || 30, 24 * 30));
  const { rows } = await db.query(
    `SELECT token_address, ts, total_tvl, best_pool_address, pool_count, source
     FROM token_meteora_snapshots
     WHERE token_address = ANY($1::varchar[])
       AND ts >= NOW() - ($2::int * INTERVAL '1 hour')
     ORDER BY token_address ASC, ts ASC`,
    [normalized, hours]
  );

  return rows;
}

async function listBaselineTvlsByAddresses(addresses, anchorTs, runner = db) {
  const normalized = normalizeAddressList(addresses);
  if (normalized.length === 0) {
    return [];
  }

  const normalizedAnchorTs = normalizeTimestamp(anchorTs);
  const { rows } = await runner.query(
    `WITH requested AS (
       SELECT UNNEST($1::varchar[]) AS token_address
     )
     SELECT
       requested.token_address,
       before_1h.total_tvl AS baseline_tvl_1h,
       before_6h.total_tvl AS baseline_tvl_6h,
       before_24h.total_tvl AS baseline_tvl_24h
     FROM requested
     LEFT JOIN LATERAL (
       SELECT total_tvl
       FROM token_meteora_snapshots
       WHERE token_address = requested.token_address
         AND total_tvl IS NOT NULL
         AND total_tvl > 0
         AND ts <= $2::timestamptz - INTERVAL '1 hour'
       ORDER BY ts DESC
       LIMIT 1
     ) AS before_1h ON TRUE
     LEFT JOIN LATERAL (
       SELECT total_tvl
       FROM token_meteora_snapshots
       WHERE token_address = requested.token_address
         AND total_tvl IS NOT NULL
         AND total_tvl > 0
         AND ts <= $2::timestamptz - INTERVAL '6 hour'
       ORDER BY ts DESC
       LIMIT 1
     ) AS before_6h ON TRUE
     LEFT JOIN LATERAL (
       SELECT total_tvl
       FROM token_meteora_snapshots
       WHERE token_address = requested.token_address
         AND total_tvl IS NOT NULL
         AND total_tvl > 0
         AND ts <= $2::timestamptz - INTERVAL '24 hour'
       ORDER BY ts DESC
       LIMIT 1
     ) AS before_24h ON TRUE
     ORDER BY requested.token_address ASC`,
    [normalized, normalizedAnchorTs]
  );

  return rows;
}

async function listLatestSummaryByAddresses(addresses) {
  const normalized = normalizeAddressList(addresses);
  if (normalized.length === 0) {
    return [];
  }

  const { rows } = await db.query(
    `WITH latest AS (
       SELECT DISTINCT ON (token_address)
         token_address,
         ts AS current_ts,
         total_tvl AS current_tvl,
         best_pool_address,
         pool_count
       FROM token_meteora_snapshots
       WHERE token_address = ANY($1::varchar[])
       ORDER BY token_address, ts DESC
     )
     SELECT
       latest.token_address,
       latest.current_ts,
       latest.current_tvl,
       latest.best_pool_address,
       latest.pool_count,
       COALESCE(before_1h.total_tvl, after_1h.total_tvl) AS baseline_tvl_1h,
       COALESCE(before_6h.total_tvl, after_6h.total_tvl) AS baseline_tvl_6h,
       COALESCE(before_24h.total_tvl, after_24h.total_tvl) AS baseline_tvl_24h
     FROM latest
     LEFT JOIN LATERAL (
       SELECT total_tvl
       FROM token_meteora_snapshots
       WHERE token_address = latest.token_address
         AND total_tvl IS NOT NULL
         AND ts <= latest.current_ts - INTERVAL '1 hour'
       ORDER BY ts DESC
       LIMIT 1
     ) AS before_1h ON TRUE
     LEFT JOIN LATERAL (
       SELECT total_tvl
       FROM token_meteora_snapshots
       WHERE token_address = latest.token_address
         AND total_tvl IS NOT NULL
         AND ts > latest.current_ts - INTERVAL '1 hour'
       ORDER BY ts ASC
       LIMIT 1
     ) AS after_1h ON TRUE
     LEFT JOIN LATERAL (
       SELECT total_tvl
       FROM token_meteora_snapshots
       WHERE token_address = latest.token_address
         AND total_tvl IS NOT NULL
         AND ts <= latest.current_ts - INTERVAL '6 hour'
       ORDER BY ts DESC
       LIMIT 1
     ) AS before_6h ON TRUE
     LEFT JOIN LATERAL (
       SELECT total_tvl
       FROM token_meteora_snapshots
       WHERE token_address = latest.token_address
         AND total_tvl IS NOT NULL
         AND ts > latest.current_ts - INTERVAL '6 hour'
       ORDER BY ts ASC
       LIMIT 1
     ) AS after_6h ON TRUE
     LEFT JOIN LATERAL (
       SELECT total_tvl
       FROM token_meteora_snapshots
       WHERE token_address = latest.token_address
         AND total_tvl IS NOT NULL
         AND ts <= latest.current_ts - INTERVAL '24 hour'
       ORDER BY ts DESC
       LIMIT 1
     ) AS before_24h ON TRUE
     LEFT JOIN LATERAL (
       SELECT total_tvl
       FROM token_meteora_snapshots
       WHERE token_address = latest.token_address
         AND total_tvl IS NOT NULL
         AND ts > latest.current_ts - INTERVAL '24 hour'
       ORDER BY ts ASC
       LIMIT 1
     ) AS after_24h ON TRUE
     ORDER BY latest.token_address ASC`,
    [normalized]
  );

  return rows;
}

async function deleteByAddresses(addresses) {
  const normalized = normalizeAddressList(addresses);
  if (normalized.length === 0) {
    return 0;
  }

  const result = await db.query(
    `DELETE FROM token_meteora_snapshots
     WHERE token_address = ANY($1::varchar[])`,
    [normalized]
  );

  return result.rowCount || 0;
}

async function deleteChunkByAddress(address, options = {}) {
  const normalized = String(address || '').trim();
  if (!isValidAddress(normalized)) {
    return 0;
  }

  const limit = Math.max(1, Math.min(Math.trunc(Number(options.limit) || 250), 1000));
  const statementTimeoutMs = Math.max(0, Math.trunc(Number(options.statementTimeoutMs) || 0));
  const result = await db.queryWithStatementTimeout(
    `WITH doomed AS (
       SELECT ctid
       FROM token_meteora_snapshots
       WHERE token_address = $1
       LIMIT $2
     )
     DELETE FROM token_meteora_snapshots
     WHERE ctid IN (SELECT ctid FROM doomed)`,
    [normalized, limit],
    statementTimeoutMs
  );

  return result.rowCount || 0;
}

module.exports = {
  insertSnapshot,
  getLatestByAddresses,
  listHistoryByAddress,
  listHistoryByAddresses,
  listBaselineTvlsByAddresses,
  listLatestSummaryByAddresses,
  deleteByAddresses,
  deleteChunkByAddress,
};
