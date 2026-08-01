const { query } = require('./db');

const DEFAULT_LIMIT = 100;

function batchLimit(value) {
  const parsed = value === undefined ? DEFAULT_LIMIT : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new TypeError('Telegram reactivation candidate limit must be between 1 and 500');
  }
  return parsed;
}

function runner(db) {
  return db && typeof db.query === 'function' ? db : { query };
}

function mapCandidate(row) {
  return Object.freeze({
    connectionId: String(row.connection_id),
    requestedAt: row.access_reactivation_requested_at,
    user: Object.freeze({
      id: row.user_id,
      role: row.user_role,
      is_active: row.user_is_active,
      access_status: row.access_status,
      access_granted_at: row.access_granted_at,
      access_expires_at: row.access_expires_at,
      access_source: row.access_source,
      access_updated_at: row.access_updated_at,
    }),
  });
}

async function listWithoutEnabledSolana(options = {}, db) {
  const { rows } = await runner(db).query(
    `SELECT connections.id AS connection_id,
            connections.access_reactivation_requested_at,
            users.id AS user_id,
            users.role AS user_role,
            users.is_active AS user_is_active,
            users.access_status,
            users.access_granted_at,
            users.access_expires_at,
            users.access_source,
            users.access_updated_at
     FROM telegram_connections connections
     JOIN users ON users.id = connections.user_id
     WHERE connections.status = 'access_suspended'
       AND users.is_active = TRUE
       AND NOT EXISTS (
         SELECT 1
         FROM telegram_alert_profiles profiles
         WHERE profiles.connection_id = connections.id
           AND profiles.chain = 'solana'
           AND profiles.enabled = TRUE
       )
     ORDER BY connections.id
     LIMIT $1`,
    [batchLimit(options.limit)],
  );
  return Object.freeze(rows.map(mapCandidate));
}

module.exports = {
  DEFAULT_LIMIT,
  listWithoutEnabledSolana,
};
