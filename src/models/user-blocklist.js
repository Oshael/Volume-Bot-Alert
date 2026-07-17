const db = require('./db');
const { normalizeTokenAddress, normalizeTokenChain } = require('../utils/token-identity');

function normalizeIdentity(address, chainValue = 'solana') {
  const chain = normalizeTokenChain(chainValue);
  return { chain, address: normalizeTokenAddress(chain, address) };
}

/**
 * Get all blocked addresses for a user.
 */
async function getAll(userId, chainValue = 'solana') {
  const chain = normalizeTokenChain(chainValue);
  const { rows } = await db.query(
    `SELECT ub.chain,
            ub.address,
            ub.label,
            ub.blocked_at,
            tc.last_image_url AS "imageUrl"
     FROM user_blocklist ub
     LEFT JOIN token_catalog tc
       ON tc.chain = ub.chain
      AND tc.address = ub.address
     WHERE ub.user_id = $1 AND ub.chain = $2
     ORDER BY ub.blocked_at DESC`,
    [userId, chain]
  );
  return rows;
}

async function getAllForChains(userId, chainValues = ['solana', 'robinhood']) {
  const chains = [...new Set(chainValues.map(normalizeTokenChain))];
  if (chains.length === 0) return [];
  const { rows } = await db.query(
    `SELECT ub.chain,
            ub.address,
            ub.label,
            ub.blocked_at,
            tc.last_image_url AS "imageUrl"
     FROM user_blocklist ub
     LEFT JOIN token_catalog tc
       ON tc.chain = ub.chain AND tc.address = ub.address
     WHERE ub.user_id = $1 AND ub.chain = ANY($2::varchar[])
     ORDER BY ub.blocked_at DESC, ub.chain ASC, ub.address ASC`,
    [userId, chains]
  );
  return rows;
}

async function count(userId, chainValue = 'solana') {
  const chain = normalizeTokenChain(chainValue);
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM user_blocklist WHERE user_id = $1 AND chain = $2`,
    [userId, chain]
  );
  return rows[0].count;
}

/**
 * Block a token. Returns the created row or null if already blocked.
 */
async function add(userId, address, label = null, chainValue = 'solana') {
  const identity = normalizeIdentity(address, chainValue);
  const { rows } = await db.query(
    `INSERT INTO user_blocklist (user_id, chain, address, label)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, chain, address) DO NOTHING
     RETURNING chain, address, label, blocked_at`,
    [userId, identity.chain, identity.address, label]
  );
  return rows[0] || null;
}

/**
 * Replace entire blocklist (PUT sync).
 */
async function setAll(userId, addresses, chainValue = 'solana') {
  const chain = normalizeTokenChain(chainValue);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_blocklist WHERE user_id = $1 AND chain = $2', [userId, chain]);
    for (const item of addresses) {
      const label = item?.label || null;
      let addr;
      try { addr = normalizeTokenAddress(chain, item?.address || item); } catch (_) { continue; }
      await client.query(
        `INSERT INTO user_blocklist (user_id, chain, address, label)
         VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, chain, address) DO NOTHING`,
        [userId, chain, addr, label]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Unblock a token. Returns true if removed.
 */
async function remove(userId, address, chainValue = 'solana') {
  const identity = normalizeIdentity(address, chainValue);
  const { rowCount } = await db.query(
    'DELETE FROM user_blocklist WHERE user_id = $1 AND chain = $2 AND address = $3',
    [userId, identity.chain, identity.address]
  );
  return rowCount > 0;
}

/**
 * Check if a token is blocked.
 */
async function isBlocked(userId, address, chainValue = 'solana') {
  const identity = normalizeIdentity(address, chainValue);
  const { rows } = await db.query(
    'SELECT 1 FROM user_blocklist WHERE user_id = $1 AND chain = $2 AND address = $3',
    [userId, identity.chain, identity.address]
  );
  return rows.length > 0;
}

module.exports = {
  count,
  getAll,
  getAllForChains,
  add,
  setAll,
  remove,
  isBlocked,
  normalizeIdentity,
};
