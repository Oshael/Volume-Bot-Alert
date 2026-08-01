const db = require('./db');

function positiveId(value, field) {
  try {
    const parsed = BigInt(String(value ?? '').trim());
    if (parsed > 0n) return parsed.toString();
  } catch (_) {}
  throw new TypeError(`${field} must be a positive integer`);
}

function requiredText(value, field, maxLength) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > maxLength) {
    throw new TypeError(`${field} must contain 1-${maxLength} characters`);
  }
  return normalized;
}

function timestamp(value, field) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError(`${field} must be a valid timestamp`);
  }
  return parsed.toISOString();
}

function mapReactivation(row) {
  if (!row) return null;
  return Object.freeze({
    connectionId: String(row.id),
    status: row.status,
    reactivatedAt: row.access_reactivated_at,
  });
}

function createTelegramAlertAccessStateRepository(options = {}) {
  const database = options.database || db;
  if (typeof database?.getClient !== 'function' || typeof database.query !== 'function') {
    throw new TypeError('Telegram access state database is required');
  }

  async function suspend(input = {}) {
    const connectionId = positiveId(input.connectionId, 'Telegram connection id');
    const userId = positiveId(input.userId, 'Telegram user id');
    const errorCode = requiredText(input.errorCode, 'Telegram access error code', 64);
    const error = requiredText(input.error, 'Telegram access error', 2000);
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT status
         FROM telegram_connections
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [connectionId, userId],
      );
      const status = locked.rows[0]?.status || null;
      let suspended = false;
      if (status === 'active' || status === 'paused') {
        const changed = await client.query(
          `UPDATE telegram_connections
           SET status = 'access_suspended', access_suspended_at = NOW(),
               access_reactivation_requested_at = NULL,
               version = version + 1, updated_at = NOW()
           WHERE id = $1 AND user_id = $2 AND status = $3`,
          [connectionId, userId, status],
        );
        suspended = changed.rowCount === 1;
      } else if (status === 'access_suspended') {
        await client.query(
          `UPDATE telegram_connections
           SET access_reactivation_requested_at = NULL,
               version = version + 1, updated_at = NOW()
           WHERE id = $1 AND user_id = $2
             AND status = 'access_suspended'
             AND access_reactivation_requested_at IS NOT NULL`,
          [connectionId, userId],
        );
      }
      const cancelled = status && status !== 'disconnected'
        ? await client.query(
          `UPDATE telegram_alert_deliveries
           SET status = 'cancelled', last_error_code = $2, last_error = $3,
               updated_at = NOW()
           WHERE connection_id = $1 AND status IN ('pending', 'retry')`,
          [connectionId, errorCode, error],
        )
        : { rowCount: 0 };
      await client.query('COMMIT');
      return Object.freeze({ status, suspended, cancelled: cancelled.rowCount });
    } catch (errorCaught) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw errorCaught;
    } finally {
      client.release();
    }
  }

  async function requestReactivation(input = {}) {
    const connectionId = positiveId(input.connectionId, 'Telegram connection id');
    const userId = positiveId(input.userId, 'Telegram user id');
    const { rows } = await database.query(
      `UPDATE telegram_connections
       SET access_reactivation_requested_at = COALESCE(
             access_reactivation_requested_at,
             date_trunc('milliseconds', NOW())
           ),
           version = version + CASE
             WHEN access_reactivation_requested_at IS NULL THEN 1 ELSE 0
           END,
           updated_at = CASE
             WHEN access_reactivation_requested_at IS NULL THEN NOW() ELSE updated_at
           END
       WHERE id = $1 AND user_id = $2 AND status = 'access_suspended'
       RETURNING id, access_reactivation_requested_at`,
      [connectionId, userId],
    );
    if (!rows[0]) return null;
    return Object.freeze({
      connectionId: String(rows[0].id),
      requestedAt: rows[0].access_reactivation_requested_at,
    });
  }

  async function completeReactivation(input = {}) {
    const connectionId = positiveId(input.connectionId, 'Telegram connection id');
    const userId = positiveId(input.userId, 'Telegram user id');
    const requestedAt = timestamp(
      input.requestedAt,
      'Telegram access reactivation request',
    );
    const { rows } = await database.query(
      `UPDATE telegram_connections
       SET status = 'active',
           access_suspended_at = NULL,
           access_reactivation_requested_at = NULL,
           access_reactivated_at = $3::timestamptz,
           version = version + 1,
           updated_at = NOW()
       WHERE id = $1
         AND user_id = $2
         AND status = 'access_suspended'
         AND access_reactivation_requested_at = $3::timestamptz
       RETURNING id, status, access_reactivated_at`,
      [connectionId, userId, requestedAt],
    );
    if (rows[0]) return mapReactivation(rows[0]);
    const existing = await database.query(
      `SELECT id, status, access_reactivated_at
       FROM telegram_connections
       WHERE id = $1
         AND user_id = $2
         AND status = 'active'
         AND access_reactivated_at = $3::timestamptz
       LIMIT 1`,
      [connectionId, userId, requestedAt],
    );
    return mapReactivation(existing.rows[0]);
  }

  async function completeReactivationWithoutEnabledSolana(input = {}) {
    const connectionId = positiveId(input.connectionId, 'Telegram connection id');
    const userId = positiveId(input.userId, 'Telegram user id');
    const requestedAt = timestamp(
      input.requestedAt,
      'Telegram access reactivation request',
    );
    const { rows } = await database.query(
      `UPDATE telegram_connections connections
       SET status = 'active',
           access_suspended_at = NULL,
           access_reactivation_requested_at = NULL,
           access_reactivated_at = $3::timestamptz,
           version = version + 1,
           updated_at = NOW()
       WHERE connections.id = $1
         AND connections.user_id = $2
         AND connections.status = 'access_suspended'
         AND connections.access_reactivation_requested_at = $3::timestamptz
         AND NOT EXISTS (
           SELECT 1
           FROM telegram_alert_profiles profiles
           WHERE profiles.connection_id = connections.id
             AND profiles.chain = 'solana'
             AND profiles.enabled = TRUE
         )
       RETURNING connections.id, connections.status,
                 connections.access_reactivated_at`,
      [connectionId, userId, requestedAt],
    );
    if (rows[0]) return mapReactivation(rows[0]);
    const existing = await database.query(
      `SELECT id, status, access_reactivated_at
       FROM telegram_connections
       WHERE id = $1
         AND user_id = $2
         AND status = 'active'
         AND access_reactivated_at = $3::timestamptz
       LIMIT 1`,
      [connectionId, userId, requestedAt],
    );
    return mapReactivation(existing.rows[0]);
  }

  return Object.freeze({
    completeReactivation,
    completeReactivationWithoutEnabledSolana,
    requestReactivation,
    suspend,
  });
}

module.exports = {
  createTelegramAlertAccessStateRepository,
};
