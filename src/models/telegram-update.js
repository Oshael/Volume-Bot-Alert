const { query } = require('./db');

const runner = (db) => (db && typeof db.query === 'function' ? db : { query });

async function receive(updateId, db) {
  const { rows } = await runner(db).query(
    `INSERT INTO telegram_updates (update_id)
     VALUES ($1)
     ON CONFLICT (update_id) DO UPDATE
     SET status = 'received', received_at = NOW(),
         processed_at = NULL, last_error = NULL
     WHERE telegram_updates.status = 'failed'
        OR (telegram_updates.status = 'received'
            AND telegram_updates.received_at < NOW() - INTERVAL '5 minutes')
     RETURNING *`,
    [String(updateId)]
  );
  return rows[0] || null;
}

async function finish(updateId, status, lastError, db) {
  if (!['processed', 'failed'].includes(status)) {
    throw new Error('Invalid Telegram update terminal status');
  }
  const { rows } = await runner(db).query(
    `UPDATE telegram_updates
     SET status = $2, processed_at = NOW(), last_error = $3
     WHERE update_id = $1 AND status = 'received'
     RETURNING *`,
    [String(updateId), status, lastError || null]
  );
  return rows[0] || null;
}

module.exports = {
  markFailed: (updateId, error, db) => finish(updateId, 'failed', error, db),
  markProcessed: (updateId, db) => finish(updateId, 'processed', null, db),
  receive,
};
