const db = require('./db');
const { isValidAddress } = require('./user-token');

function toNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

async function insertSnapshot(snapshot) {
  const address = String(snapshot.tokenAddress || snapshot.address || '').trim();
  if (!isValidAddress(address)) {
    throw new Error('Invalid token address format');
  }

  const { rows } = await db.query(
    `INSERT INTO token_market_snapshots (
       token_address, ts, mcap, price, vol_5m, vol_1h, vol_6h, vol_24h, source
     )
     VALUES ($1, COALESCE($2, NOW()), $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      address,
      snapshot.ts || null,
      toNumberOrNull(snapshot.mcap),
      toNumberOrNull(snapshot.price),
      toNumberOrNull(snapshot.vol5m),
      toNumberOrNull(snapshot.vol1h),
      toNumberOrNull(snapshot.vol6h),
      toNumberOrNull(snapshot.vol24h),
      String(snapshot.source || 'dexscreener').trim().toLowerCase(),
    ]
  );

  return rows[0];
}

async function listRecentByAddress(address, limit = 100) {
  const addr = String(address || '').trim();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const { rows } = await db.query(
    `SELECT *
     FROM token_market_snapshots
     WHERE token_address = $1
     ORDER BY ts DESC
     LIMIT $2`,
    [addr, safeLimit]
  );
  return rows;
}

async function listHistoryByAddress(address, options = {}) {
  const addr = String(address || '').trim();
  if (!isValidAddress(addr)) {
    throw new Error('Invalid token address format');
  }

  const limit = Math.max(1, Math.min(Number(options.limit) || 168, 1000));
  const hours = options.hours == null ? null : Math.max(1, Math.min(Number(options.hours) || 0, 24 * 30));
  const days = options.days == null ? null : Math.max(1, Math.min(Number(options.days) || 0, 30));

  let lookbackHours = hours;
  if (lookbackHours == null && days != null) {
    lookbackHours = days * 24;
  }

  const params = [addr, limit];
  let whereExtra = '';
  if (lookbackHours != null) {
    params.push(lookbackHours);
    whereExtra = `AND ts >= NOW() - ($3::int * INTERVAL '1 hour')`;
  }

  const { rows } = await db.query(
    `SELECT token_address, ts, mcap, price, vol_5m, vol_1h, vol_6h, vol_24h, source
     FROM token_market_snapshots
     WHERE token_address = $1
       ${whereExtra}
     ORDER BY ts DESC
     LIMIT $2`,
    params
  );

  return rows.reverse();
}

async function listLatestByAddresses(addresses, limitPerAddress = 2) {
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

  const safeLimit = Math.max(1, Math.min(Number(limitPerAddress) || 2, 120));
  const { rows } = await db.query(
    `WITH ranked AS (
       SELECT
         token_address,
         ts,
         mcap,
         price,
         vol_5m,
         vol_1h,
         vol_6h,
         vol_24h,
         source,
         ROW_NUMBER() OVER (PARTITION BY token_address ORDER BY ts DESC) AS rn
       FROM token_market_snapshots
       WHERE token_address = ANY($1::varchar[])
     )
     SELECT token_address, ts, mcap, price, vol_5m, vol_1h, vol_6h, vol_24h, source
     FROM ranked
     WHERE rn <= $2
     ORDER BY token_address ASC, ts DESC`,
    [unique, safeLimit]
  );

  return rows;
}

module.exports = {
  insertSnapshot,
  listRecentByAddress,
  listHistoryByAddress,
  listLatestByAddresses,
};
