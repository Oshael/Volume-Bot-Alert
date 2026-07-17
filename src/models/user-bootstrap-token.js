const db = require('./db');
const { normalizeTokenAddress, normalizeTokenChain } = require('../utils/token-identity');

async function getAll(userId, chainValue = 'solana') {
  const chain = normalizeTokenChain(chainValue);
  const { rows } = await db.query(
    `SELECT chain, address, added_at
     FROM user_bootstrap_tokens
     WHERE user_id = $1 AND chain = $2
     ORDER BY added_at ASC`,
    [userId, chain]
  );
  return rows;
}

async function setAll(userId, addresses, chainValue = 'solana') {
  const chain = normalizeTokenChain(chainValue);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_bootstrap_tokens WHERE user_id = $1 AND chain = $2', [userId, chain]);
    for (const item of addresses) {
      let addr;
      try { addr = normalizeTokenAddress(chain, item?.address || item); } catch (_) { continue; }
      await client.query(
        `INSERT INTO user_bootstrap_tokens (user_id, chain, address)
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
  getAll,
  setAll,
};
