const db = require('./db');
const { isValidAddress } = require('./user-token');

function toNumberOrNull(value) {
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

async function insertSnapshot(snapshot) {
  const address = normalizeAddress(snapshot.tokenAddress || snapshot.address);

  const { rows } = await db.query(
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

module.exports = {
  insertSnapshot,
  getLatestByAddresses,
  listHistoryByAddress,
  listHistoryByAddresses,
};
