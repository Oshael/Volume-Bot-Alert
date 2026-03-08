const db = require('./db');

// Solana address: base58, 32-44 chars
// Ethereum/BSC/Base: hex, 42 chars (0x + 40)
const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Validate a token address.
 */
function isValidAddress(address) {
  if (typeof address !== 'string') return false;
  const trimmed = address.trim();
  return SOLANA_ADDR_RE.test(trimmed) || EVM_ADDR_RE.test(trimmed);
}

/**
 * Get all manual tokens for a user.
 */
async function getAll(userId) {
  const { rows } = await db.query(
    `SELECT address, label, added_at
     FROM user_tokens
     WHERE user_id = $1
     ORDER BY added_at ASC`,
    [userId]
  );
  return rows;
}

/**
 * Add a manual token. Returns the created row or null if duplicate.
 */
async function add(userId, address, label = null) {
  const addr = address.trim();
  try {
    const { rows } = await db.query(
      `INSERT INTO user_tokens (user_id, address, label)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, address) DO NOTHING
       RETURNING address, label, added_at`,
      [userId, addr, label]
    );
    return rows[0] || null; // null = already existed
  } catch (err) {
    throw err;
  }
}

/**
 * Add multiple tokens at once (for PUT sync). Ignores duplicates.
 */
async function setAll(userId, tokens) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // Clear existing
    await client.query('DELETE FROM user_tokens WHERE user_id = $1', [userId]);
    // Insert new
    for (const tok of tokens) {
      const addr = (tok.address || tok).toString().trim();
      const label = tok.label || null;
      if (isValidAddress(addr)) {
        await client.query(
          'INSERT INTO user_tokens (user_id, address, label) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [userId, addr, label]
        );
      }
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
 * Remove a manual token. Returns true if deleted.
 */
async function remove(userId, address) {
  const { rowCount } = await db.query(
    'DELETE FROM user_tokens WHERE user_id = $1 AND address = $2',
    [userId, address.trim()]
  );
  return rowCount > 0;
}

/**
 * Count tokens for a user (for rate limiting).
 */
async function count(userId) {
  const { rows } = await db.query(
    'SELECT COUNT(*)::int AS count FROM user_tokens WHERE user_id = $1',
    [userId]
  );
  return rows[0].count;
}

module.exports = {
  isValidAddress,
  getAll,
  add,
  setAll,
  remove,
  count,
};
