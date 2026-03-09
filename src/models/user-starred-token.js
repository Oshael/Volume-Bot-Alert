const db = require('./db');
const { isValidAddress } = require('./user-token');

async function getAll(userId) {
  const { rows } = await db.query(
    `SELECT address, starred_at
     FROM user_starred_tokens
     WHERE user_id = $1
     ORDER BY starred_at ASC`,
    [userId]
  );
  return rows;
}

async function setAll(userId, addresses) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_starred_tokens WHERE user_id = $1', [userId]);
    for (const item of addresses) {
      const addr = (item.address || item).toString().trim();
      if (isValidAddress(addr)) {
        await client.query(
          'INSERT INTO user_starred_tokens (user_id, address) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [userId, addr]
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

module.exports = {
  getAll,
  setAll,
};
