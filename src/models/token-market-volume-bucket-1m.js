const db = require('./db');
const { isValidAddress } = require('./user-token');

function toNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

const VOLUME_COLUMN_BY_WINDOW = Object.freeze({
  '1m': 'close_vol_1m',
  '5m': 'close_vol_5m',
  '1h': 'close_vol_1h',
  '6h': 'close_vol_6h',
  '24h': 'close_vol_24h',
});

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
  const address = String(snapshot.tokenAddress || snapshot.address || '').trim();
  if (!isValidAddress(address)) {
    throw new Error('Invalid token address format');
  }

  const bucketTs = getBucketDate(snapshot.ts || new Date());
  const vol1m = toNumberOrNull(snapshot.vol1m);
  const vol5m = toNumberOrNull(snapshot.vol5m);
  const vol1h = toNumberOrNull(snapshot.vol1h);
  const vol6h = toNumberOrNull(snapshot.vol6h);
  const vol24h = toNumberOrNull(snapshot.vol24h);
  const source = String(snapshot.source || 'dexscreener').trim().toLowerCase() || 'dexscreener';

  const { rows } = await db.query(
    `INSERT INTO token_market_volume_buckets_1m (
       token_address,
       bucket_ts,
       close_vol_1m,
       close_vol_5m,
       close_vol_1h,
       close_vol_6h,
       close_vol_24h,
       sample_count,
       source
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8)
     ON CONFLICT (token_address, bucket_ts) DO UPDATE SET
       close_vol_1m = COALESCE(EXCLUDED.close_vol_1m, token_market_volume_buckets_1m.close_vol_1m),
       close_vol_5m = COALESCE(EXCLUDED.close_vol_5m, token_market_volume_buckets_1m.close_vol_5m),
       close_vol_1h = COALESCE(EXCLUDED.close_vol_1h, token_market_volume_buckets_1m.close_vol_1h),
       close_vol_6h = COALESCE(EXCLUDED.close_vol_6h, token_market_volume_buckets_1m.close_vol_6h),
       close_vol_24h = COALESCE(EXCLUDED.close_vol_24h, token_market_volume_buckets_1m.close_vol_24h),
       sample_count = token_market_volume_buckets_1m.sample_count + 1,
       source = COALESCE(EXCLUDED.source, token_market_volume_buckets_1m.source)
     RETURNING *`,
    [address, bucketTs, vol1m, vol5m, vol1h, vol6h, vol24h, source]
  );

  return rows[0];
}

async function listCurrentAndBaselineByAddresses(addresses, windowMinutes = 5, options = {}) {
  const unique = Array.from(
    new Set(
      (Array.isArray(addresses) ? addresses : [])
        .map((item) => String(item || '').trim())
        .filter((item) => isValidAddress(item))
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
       WHERE token_address = requested.token_address
       ORDER BY bucket_ts DESC
       LIMIT 1
     ) AS current_row ON TRUE
     LEFT JOIN LATERAL (
       SELECT bucket_ts, ${volumeColumn} AS baseline_volume
       FROM token_market_volume_buckets_1m
       WHERE token_address = requested.token_address
         AND ${volumeColumn} IS NOT NULL
         AND current_row.current_ts IS NOT NULL
         AND bucket_ts <= current_row.current_ts - ($2::int * INTERVAL '1 minute')
       ORDER BY bucket_ts DESC
       LIMIT 1
     ) AS target ON TRUE
     LEFT JOIN LATERAL (
       SELECT bucket_ts, ${volumeColumn} AS baseline_volume
       FROM token_market_volume_buckets_1m
       WHERE token_address = requested.token_address
         AND ${volumeColumn} IS NOT NULL
         AND current_row.current_ts IS NOT NULL
         AND bucket_ts < current_row.current_ts
       ORDER BY bucket_ts ASC
       LIMIT 1
     ) AS fallback ON target.bucket_ts IS NULL
     ORDER BY requested.token_address ASC`,
    [unique, safeWindowMinutes]
  );

  return rows;
}

async function deleteByAddresses(addresses) {
  const unique = Array.from(
    new Set(
      (Array.isArray(addresses) ? addresses : [])
        .map((item) => String(item || '').trim())
        .filter((item) => isValidAddress(item))
    )
  );
  if (!unique.length) {
    return 0;
  }

  const result = await db.query(
    `DELETE FROM token_market_volume_buckets_1m
     WHERE token_address = ANY($1::varchar[])`,
    [unique]
  );

  return result.rowCount || 0;
}

module.exports = {
  upsertSnapshotBucket,
  listCurrentAndBaselineByAddresses,
  deleteByAddresses,
  __private: {
    getBucketDate,
    normalizeVolumeWindow,
  },
};
