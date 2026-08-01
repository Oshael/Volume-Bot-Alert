const db = require('./db');

function runner(value) {
  return value && typeof value.query === 'function' ? value : db;
}

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

function mapRow(row) {
  if (!row) return null;
  const userId = Number(row.user_id);
  return {
    claim: {
      deliveryId: String(row.delivery_id),
      connectionId: String(row.connection_id),
      profileId: String(row.profile_id),
      chain: row.chain,
    },
    connection: {
      id: String(row.connection_id),
      userId,
      chatId: String(row.chat_id),
      status: row.connection_status,
      languageCode: row.language_code,
    },
    profile: {
      id: String(row.profile_id),
      connectionId: String(row.connection_id),
      userId,
      chain: row.chain,
      enabled: row.profile_enabled,
      sparklineEnabled: row.sparkline_enabled,
    },
    user: {
      id: userId,
      role: row.user_role,
      is_active: row.user_is_active,
      access_status: row.access_status,
      access_granted_at: row.access_granted_at,
      access_expires_at: row.access_expires_at,
      access_source: row.access_source,
      access_updated_at: row.access_updated_at,
    },
  };
}

function createTelegramAlertDeliveryContextRepository(options = {}) {
  const database = runner(options.database);

  async function loadClaim(input = {}) {
    const id = positiveId(input.id, 'Telegram delivery id');
    const owner = requiredText(input.owner, 'Telegram delivery lease owner', 128);
    const { rows } = await database.query(
      `SELECT
         deliveries.id AS delivery_id,
         deliveries.connection_id,
         deliveries.profile_id,
         deliveries.chain,
         connections.user_id,
         connections.chat_id,
         connections.language_code,
         connections.status AS connection_status,
         profiles.enabled AS profile_enabled,
         profiles.sparkline_enabled,
         users.role AS user_role,
         users.is_active AS user_is_active,
         users.access_status,
         users.access_granted_at,
         users.access_expires_at,
         users.access_source,
         users.access_updated_at
       FROM telegram_alert_deliveries deliveries
       JOIN telegram_connections connections
         ON connections.id = deliveries.connection_id
       JOIN telegram_alert_profiles profiles
         ON profiles.id = deliveries.profile_id
        AND profiles.connection_id = deliveries.connection_id
        AND profiles.chain = deliveries.chain
        AND profiles.user_id = connections.user_id
       JOIN users
         ON users.id = connections.user_id
       WHERE deliveries.id = $1
         AND deliveries.status = 'claimed'
         AND deliveries.lease_owner = $2
         AND deliveries.lease_until > NOW()
       LIMIT 1`,
      [id, owner],
    );
    return mapRow(rows[0]);
  }

  return Object.freeze({ loadClaim });
}

module.exports = {
  createTelegramAlertDeliveryContextRepository,
};
