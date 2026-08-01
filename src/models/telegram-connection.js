const { query } = require('./db');
const {
  DEFAULT_LANGUAGE_CODE,
  normalizeTelegramLanguageCode,
} = require('../utils/telegram-locale');

const runner = (db) => (db && typeof db.query === 'function' ? db : { query });
const DELIVERY_STATUSES = Object.freeze(['active', 'paused']);

function requireDeliveryStatus(status) {
  if (!DELIVERY_STATUSES.includes(status)) {
    throw new TypeError(`Unsupported Telegram delivery status: ${status}`);
  }
  return status;
}

async function create(input, db) {
  const languageCode = normalizeTelegramLanguageCode(input.languageCode)
    || DEFAULT_LANGUAGE_CODE;
  const { rows } = await runner(db).query(
    `INSERT INTO telegram_connections (
       user_id, telegram_user_id, chat_id, username, first_name, language_code
     ) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.userId,
      String(input.telegramUserId),
      String(input.chatId),
      String(input.username || '').trim() || null,
      String(input.firstName || '').trim() || null,
      languageCode,
    ]
  );
  return rows[0] || null;
}

async function updateLanguageCode(input, db) {
  const languageCode = normalizeTelegramLanguageCode(input.languageCode);
  if (!languageCode) throw new TypeError('Telegram language code is invalid');
  const { rows } = await runner(db).query(
    `UPDATE telegram_connections
     SET language_code = $2, updated_at = NOW()
     WHERE id = $1
       AND status <> 'disconnected'
       AND language_code IS DISTINCT FROM $2
     RETURNING *`,
    [input.id, languageCode]
  );
  return rows[0] || null;
}

async function findActiveByUserId(userId, db) {
  const { rows } = await runner(db).query(
    `SELECT * FROM telegram_connections
     WHERE user_id = $1 AND status <> 'disconnected'
     LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function findActiveByTelegramUserId(telegramUserId, db) {
  const { rows } = await runner(db).query(
    `SELECT * FROM telegram_connections
     WHERE telegram_user_id = $1 AND status <> 'disconnected'
     LIMIT 1`,
    [String(telegramUserId)]
  );
  return rows[0] || null;
}

async function disconnect(id, db, expectedVersion) {
  const { rows } = await runner(db).query(
    `UPDATE telegram_connections
     SET status = 'disconnected', disconnected_at = NOW(),
         access_suspended_at = NULL, access_reactivation_requested_at = NULL,
         access_reactivated_at = NULL,
         version = version + 1, updated_at = NOW()
     WHERE id = $1
       AND status <> 'disconnected'
       AND ($2::integer IS NULL OR version = $2)
     RETURNING *`,
    [id, expectedVersion ?? null]
  );
  return rows[0] || null;
}

async function setDeliveryStatus(input, db) {
  const { rows } = await runner(db).query(
    `UPDATE telegram_connections
     SET status = $2, version = version + 1, updated_at = NOW()
     WHERE user_id = $1
       AND status IN ('active', 'paused')
       AND version = $3
     RETURNING *`,
    [input.userId, requireDeliveryStatus(input.status), input.expectedVersion]
  );
  return rows[0] || null;
}

module.exports = {
  create,
  disconnect,
  findActiveByTelegramUserId,
  findActiveByUserId,
  setDeliveryStatus,
  updateLanguageCode,
};
