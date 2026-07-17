const db = require('./db');
const { normalizeTokenAddress, normalizeTokenChain } = require('../utils/token-identity');

async function getAll(userId, chainValue = 'solana') {
  const chain = normalizeTokenChain(chainValue);
  const { rows } = await db.query(
    `SELECT chain, address, starred_at
     FROM user_starred_tokens
     WHERE user_id = $1 AND chain = $2
     ORDER BY starred_at ASC`,
    [userId, chain]
  );
  return rows;
}

async function getAllForChains(userId, chainValues = ['solana', 'robinhood']) {
  const chains = [...new Set(chainValues.map(normalizeTokenChain))];
  if (chains.length === 0) return [];
  const { rows } = await db.query(
    `SELECT chain, address, starred_at
     FROM user_starred_tokens
     WHERE user_id = $1 AND chain = ANY($2::varchar[])
     ORDER BY starred_at ASC, chain ASC, address ASC`,
    [userId, chains]
  );
  return rows;
}

async function add(userId, address, chainValue = 'solana') {
  const chain = normalizeTokenChain(chainValue);
  const normalizedAddress = normalizeTokenAddress(chain, address);
  const { rows } = await db.query(
    `INSERT INTO user_starred_tokens (user_id, chain, address)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, chain, address) DO NOTHING
     RETURNING chain, address, starred_at`,
    [userId, chain, normalizedAddress]
  );
  return rows[0] || null;
}

async function remove(userId, address, chainValue = 'solana') {
  const chain = normalizeTokenChain(chainValue);
  const normalizedAddress = normalizeTokenAddress(chain, address);
  const { rowCount } = await db.query(
    `DELETE FROM user_starred_tokens
     WHERE user_id = $1 AND chain = $2 AND address = $3`,
    [userId, chain, normalizedAddress]
  );
  return rowCount > 0;
}

async function count(userId, chainValue = 'solana') {
  const chain = normalizeTokenChain(chainValue);
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM user_starred_tokens WHERE user_id = $1 AND chain = $2`,
    [userId, chain]
  );
  return rows[0].count;
}

async function setAll(userId, addresses, chainValue = 'solana') {
  const chain = normalizeTokenChain(chainValue);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_starred_tokens WHERE user_id = $1 AND chain = $2', [userId, chain]);
    for (const item of addresses) {
      let addr;
      try { addr = normalizeTokenAddress(chain, item?.address || item); } catch (_) { continue; }
      await client.query(
        `INSERT INTO user_starred_tokens (user_id, chain, address)
         VALUES ($1, $2, $3) ON CONFLICT (user_id, chain, address) DO NOTHING`,
        [userId, chain, addr]
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

module.exports = {
  add,
  count,
  getAll,
  getAllForChains,
  remove,
  setAll,
};
