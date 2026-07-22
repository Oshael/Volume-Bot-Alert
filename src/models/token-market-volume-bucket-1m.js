const db = require('./db');
const { normalizeTokenAddress, normalizeTokenChain } = require('../utils/token-identity');

function toNumberOrNull(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

const COVERAGE_STATES = new Set(['complete', 'partial', 'unavailable']);

const VOLUME_COLUMN_BY_WINDOW = Object.freeze({
  '1m': 'close_vol_1m',
  '5m': 'close_vol_5m',
  '1h': 'close_vol_1h',
  '6h': 'close_vol_6h',
  '24h': 'close_vol_24h',
});
const VOLUME_TABLE = 'token_market_volume_buckets_1m';

function coverageStateSql(reference, window) {
  return `CASE jsonb_typeof(${reference}.window_coverage -> '${window}')
    WHEN 'object' THEN ${reference}.window_coverage -> '${window}' ->> 'state'
    WHEN 'string' THEN ${reference}.window_coverage ->> '${window}'
    ELSE NULL END`;
}

function coverageRankSql(reference, window) {
  return `CASE (${coverageStateSql(reference, window)})
    WHEN 'complete' THEN 2 WHEN 'partial' THEN 1 ELSE 0 END`;
}

function preserveStoredWindowSql(window) {
  const column = VOLUME_COLUMN_BY_WINDOW[window];
  return `EXCLUDED.${column} IS NULL OR (
    ${VOLUME_TABLE}.${column} IS NOT NULL
    AND (${coverageRankSql(VOLUME_TABLE, window)})
      > (${coverageRankSql('EXCLUDED', window)})
  )`;
}

function preferredVolumeAssignmentSql(window) {
  const column = VOLUME_COLUMN_BY_WINDOW[window];
  return `${column} = CASE WHEN (${preserveStoredWindowSql(window)})
    THEN ${VOLUME_TABLE}.${column} ELSE EXCLUDED.${column} END`;
}

function preferredCoverageEntrySql(window) {
  return `'${window}', CASE WHEN (${preserveStoredWindowSql(window)})
    THEN ${VOLUME_TABLE}.window_coverage -> '${window}'
    ELSE EXCLUDED.window_coverage -> '${window}' END`;
}

const UPSERT_SNAPSHOT_SQL = `INSERT INTO token_market_volume_buckets_1m (
       chain,
       token_address,
       bucket_ts,
       close_vol_1m,
       close_vol_5m,
       close_vol_1h,
       close_vol_6h,
       close_vol_24h,
       sample_count,
       source,
       window_coverage
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10::jsonb)
     ON CONFLICT (chain, token_address, bucket_ts) DO UPDATE SET
       ${Object.keys(VOLUME_COLUMN_BY_WINDOW).map(preferredVolumeAssignmentSql).join(',\n       ')},
       sample_count = token_market_volume_buckets_1m.sample_count + 1,
       source = COALESCE(EXCLUDED.source, token_market_volume_buckets_1m.source),
       window_coverage = jsonb_strip_nulls(jsonb_build_object(
         ${Object.keys(VOLUME_COLUMN_BY_WINDOW).map(preferredCoverageEntrySql).join(',\n         ')}
       ))
     RETURNING *`;

function normalizeWindowCoverage(snapshot, values, source) {
  const supplied = snapshot.volumeCoverage && typeof snapshot.volumeCoverage === 'object'
    ? snapshot.volumeCoverage
    : {};
  const coverage = {};
  for (const [window, value] of Object.entries(values)) {
    if (value == null) continue;
    const state = String(supplied[window] || 'partial').trim().toLowerCase();
    coverage[window] = {
      state: COVERAGE_STATES.has(state) ? state : 'partial',
      source,
    };
  }
  return coverage;
}

function normalizeVolumeWindow(value) {
  const normalized = String(value || '5m').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(VOLUME_COLUMN_BY_WINDOW, normalized) ? normalized : '5m';
}

function getBucketDate(value = new Date()) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('Invalid bucket timestamp');
  }

  date.setUTCSeconds(0, 0);
  return date;
}

async function upsertSnapshotBucket(snapshot) {
  const chain = normalizeTokenChain(snapshot.chain || 'solana');
  const address = normalizeTokenAddress(chain, snapshot.tokenAddress || snapshot.address);

  const bucketTs = getBucketDate(snapshot.ts || new Date());
  const vol1m = toNumberOrNull(snapshot.vol1m);
  const vol5m = toNumberOrNull(snapshot.vol5m);
  const vol1h = toNumberOrNull(snapshot.vol1h);
  const vol6h = toNumberOrNull(snapshot.vol6h);
  const vol24h = toNumberOrNull(snapshot.vol24h);
  const source = String(snapshot.source || 'dexscreener').trim().toLowerCase() || 'dexscreener';
  const windowCoverage = normalizeWindowCoverage(snapshot, {
    '1m': vol1m, '5m': vol5m, '1h': vol1h, '6h': vol6h, '24h': vol24h,
  }, source);

  const { rows } = await db.query(
    UPSERT_SNAPSHOT_SQL,
    [
      chain, address, bucketTs, vol1m, vol5m, vol1h, vol6h, vol24h,
      source, JSON.stringify(windowCoverage),
    ]
  );

  return rows[0];
}

async function listCurrentAndBaselineByAddresses(addresses, windowMinutes = 5, options = {}) {
  const chain = normalizeTokenChain(options.chain || 'solana');
  const unique = Array.from(
    new Set(
      (Array.isArray(addresses) ? addresses : [])
        .map((item) => {
          try { return normalizeTokenAddress(chain, item); } catch (_) { return null; }
        })
        .filter(Boolean)
    )
  );
  if (!unique.length) {
    return [];
  }

  const safeWindowMinutes = Math.max(1, Math.min(Number(windowMinutes) || 5, 60));
  const volumeWindow = normalizeVolumeWindow(options.volumeWindow);
  const volumeColumn = VOLUME_COLUMN_BY_WINDOW[volumeWindow];
  const { rows } = await db.query(
    `WITH requested AS (
       SELECT UNNEST($1::varchar[]) AS token_address
     )
     SELECT
       requested.token_address,
       current_row.current_ts,
       current_row.current_volume,
       current_row.current_volume AS current_vol_${volumeWindow},
       COALESCE(target.bucket_ts, fallback.bucket_ts) AS baseline_ts,
       COALESCE(target.baseline_volume, fallback.baseline_volume) AS baseline_vol,
       COALESCE(target.baseline_volume, fallback.baseline_volume) AS baseline_vol_${volumeWindow}
     FROM requested
     LEFT JOIN LATERAL (
       SELECT
         bucket_ts AS current_ts,
         ${volumeColumn} AS current_volume
       FROM token_market_volume_buckets_1m
       WHERE chain = $3
         AND token_address = requested.token_address
       ORDER BY bucket_ts DESC
       LIMIT 1
     ) AS current_row ON TRUE
     LEFT JOIN LATERAL (
       SELECT bucket_ts, ${volumeColumn} AS baseline_volume
       FROM token_market_volume_buckets_1m
       WHERE chain = $3
         AND token_address = requested.token_address
         AND ${volumeColumn} IS NOT NULL
         AND current_row.current_ts IS NOT NULL
         AND bucket_ts <= current_row.current_ts - ($2::int * INTERVAL '1 minute')
       ORDER BY bucket_ts DESC
       LIMIT 1
     ) AS target ON TRUE
     LEFT JOIN LATERAL (
       SELECT bucket_ts, ${volumeColumn} AS baseline_volume
       FROM token_market_volume_buckets_1m
       WHERE chain = $3
         AND token_address = requested.token_address
         AND ${volumeColumn} IS NOT NULL
         AND current_row.current_ts IS NOT NULL
         AND bucket_ts < current_row.current_ts
       ORDER BY bucket_ts ASC
       LIMIT 1
     ) AS fallback ON target.bucket_ts IS NULL
     ORDER BY requested.token_address ASC`,
    [unique, safeWindowMinutes, chain]
  );

  return rows;
}

async function deleteByAddresses(addresses, chainValue = 'solana') {
  const chain = normalizeTokenChain(chainValue);
  const unique = Array.from(
    new Set(
      (Array.isArray(addresses) ? addresses : [])
        .map((item) => {
          try { return normalizeTokenAddress(chain, item); } catch (_) { return null; }
        })
        .filter(Boolean)
    )
  );
  if (!unique.length) {
    return 0;
  }

  const result = await db.query(
    `DELETE FROM token_market_volume_buckets_1m
     WHERE chain = $1
       AND token_address = ANY($2::varchar[])`,
    [chain, unique]
  );

  return result.rowCount || 0;
}

async function deleteChunkByAddress(address, options = {}) {
  const chain = normalizeTokenChain(options.chain || 'solana');
  let normalized;
  try { normalized = normalizeTokenAddress(chain, address); } catch (_) { return 0; }

  const limit = Math.max(1, Math.min(Math.trunc(Number(options.limit) || 250), 1000));
  const statementTimeoutMs = Math.max(0, Math.trunc(Number(options.statementTimeoutMs) || 0));
  const result = await db.queryWithStatementTimeout(
    `WITH doomed AS (
       SELECT ctid
       FROM token_market_volume_buckets_1m
       WHERE chain = $1
         AND token_address = $2
       LIMIT $3
     )
     DELETE FROM token_market_volume_buckets_1m
     WHERE ctid IN (SELECT ctid FROM doomed)`,
    [chain, normalized, limit],
    statementTimeoutMs
  );

  return result.rowCount || 0;
}

module.exports = {
  upsertSnapshotBucket,
  listCurrentAndBaselineByAddresses,
  deleteByAddresses,
  deleteChunkByAddress,
  __private: {
    UPSERT_SNAPSHOT_SQL,
    getBucketDate,
    normalizeWindowCoverage,
    normalizeVolumeWindow,
  },
};
