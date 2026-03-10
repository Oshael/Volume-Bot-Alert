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

module.exports = {
  insertSnapshot,
  listRecentByAddress,
};
