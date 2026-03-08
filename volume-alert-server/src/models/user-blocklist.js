const db = require('./db');
const { isValidAddress } = require('./user-token');

/**
 * Get all blocked addresses for a user.
 */
async function getAll(userId) {
  const { rows } = await db.query(
    `SELECT address, label, blocked_at
     FROM user_blocklist
     WHERE user_id = $1
     ORDER BY blocked_at DESC`,
    [userId]
  );
  return rows;
}

/**
 * Block a token. Returns the created row or null if already blocked.
 */
async function add(userId, address, label = null) {
  const addr = address.trim();
  try {
    const { rows } = await db.query(
      `INSERT INTO user_blocklist (user_id, address, label)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, address) DO NOTHING
       RETURNING address, label, blocked_at`,
      [userId, addr, label]
    );
    return rows[0] || null;
  } catch (err) {
    throw err;
  }
}

/**
 * Replace entire blocklist (PUT sync).
 */
async function setAll(userId, addresses) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_blocklist WHERE user_id = $1', [userId]);
    for (const item of addresses) {
      const addr = (item.address || item).toString().trim();
      const label = item.label || null;
      if (isValidAddress(addr)) {
        await client.query(
          'INSERT INTO user_blocklist (user_id, address, label) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
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
 * Unblock a token. Returns true if removed.
 */
async function remove(userId, address) {
  const { rowCount } = await db.query(
    'DELETE FROM user_blocklist WHERE user_id = $1 AND address = $2',
    [userId, address.trim()]
  );
  return rowCount > 0;
}

/**
 * Check if a token is blocked.
 */
async function isBlocked(userId, address) {
  const { rows } = await db.query(
    'SELECT 1 FROM user_blocklist WHERE user_id = $1 AND address = $2',
    [userId, address.trim()]
  );
  return rows.length > 0;
}

module.exports = {
  getAll,
  add,
  setAll,
  remove,
  isBlocked,
};
