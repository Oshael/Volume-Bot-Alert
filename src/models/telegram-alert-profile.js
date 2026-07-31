const { query } = require('./db');

const CHAINS = Object.freeze(['solana', 'robinhood']);
const runner = (db) => (db && typeof db.query === 'function' ? db : { query });

function requireChain(chain) {
  if (!CHAINS.includes(chain)) {
    throw new TypeError(`Unsupported Telegram alert chain: ${chain}`);
  }
  return chain;
}

async function bindConnection(input, db) {
  const database = runner(db);
  await database.query(
    `INSERT INTO telegram_alert_profiles (user_id, connection_id, chain)
     SELECT $1, $2, chain
     FROM unnest($3::varchar[]) AS chain
     ON CONFLICT (user_id, chain) DO UPDATE
     SET connection_id = EXCLUDED.connection_id,
         version = telegram_alert_profiles.version + 1,
         updated_at = NOW()
     WHERE telegram_alert_profiles.connection_id IS DISTINCT FROM EXCLUDED.connection_id
     RETURNING *`,
    [input.userId, input.connectionId, CHAINS]
  );
  const { rows } = await database.query(
    `SELECT * FROM telegram_alert_profiles
     WHERE user_id = $1
     ORDER BY chain`,
    [input.userId]
  );
  return rows;
}

async function findByUserAndChain(userId, chain, db) {
  const { rows } = await runner(db).query(
    `SELECT * FROM telegram_alert_profiles
     WHERE user_id = $1 AND chain = $2
     LIMIT 1`,
    [userId, requireChain(chain)]
  );
  return rows[0] || null;
}

async function updatePreferences(input, db) {
  const updates = [input.enabled, input.sparklineEnabled];
  if (!updates.some((value) => typeof value === 'boolean')) {
    throw new TypeError('At least one Telegram profile preference is required');
  }
  if (updates.some((value) => value !== undefined && typeof value !== 'boolean')) {
    throw new TypeError('Telegram profile preferences must be boolean');
  }

  const { rows } = await runner(db).query(
    `UPDATE telegram_alert_profiles
     SET enabled = COALESCE($3, enabled),
         sparkline_enabled = COALESCE($4, sparkline_enabled),
         version = version + 1,
         updated_at = NOW()
     WHERE user_id = $1
       AND chain = $2
       AND version = $5
     RETURNING *`,
    [
      input.userId,
      requireChain(input.chain),
      input.enabled ?? null,
      input.sparklineEnabled ?? null,
      input.expectedVersion,
    ]
  );
  return rows[0] || null;
}

module.exports = {
  CHAINS,
  bindConnection,
  findByUserAndChain,
  updatePreferences,
};
