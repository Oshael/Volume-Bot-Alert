const { query } = require('./db');

const runner = (db) => (db && typeof db.query === 'function' ? db : { query });

async function replace(input, db) {
  const { rows } = await runner(db).query(
    `INSERT INTO telegram_input_sessions (
       telegram_user_id, user_id, action, payload_json, expires_at
     ) VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (telegram_user_id) DO UPDATE
     SET user_id = EXCLUDED.user_id,
         action = EXCLUDED.action,
         payload_json = EXCLUDED.payload_json,
         expires_at = EXCLUDED.expires_at,
         created_at = NOW(),
         updated_at = NOW()
     RETURNING *`,
    [
      String(input.telegramUserId),
      input.userId,
      input.action,
      JSON.stringify(input.payload),
      input.expiresAt,
    ]
  );
  return rows[0] || null;
}

async function findActive(input, db) {
  const { rows } = await runner(db).query(
    `SELECT * FROM telegram_input_sessions
     WHERE telegram_user_id = $1
       AND user_id = $2
       AND expires_at > NOW()
     LIMIT 1`,
    [String(input.telegramUserId), input.userId]
  );
  return rows[0] || null;
}

async function clear(input, db) {
  const { rowCount } = await runner(db).query(
    `DELETE FROM telegram_input_sessions
     WHERE telegram_user_id = $1 AND user_id = $2`,
    [String(input.telegramUserId), input.userId]
  );
  return rowCount;
}

module.exports = { clear, findActive, replace };
