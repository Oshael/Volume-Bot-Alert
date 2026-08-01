const config = require('../../config');
const db = require('../models/db');
const connectionModel = require('../models/telegram-connection');
const inputSessionModel = require('../models/telegram-input-session');
const linkTokenModel = require('../models/telegram-link-token');
const profileModel = require('../models/telegram-alert-profile');
const ruleSettingModel = require('../models/telegram-alert-rule-setting');
const User = require('../models/user');
const userAccess = require('../models/user-access');
const {
  DEFAULT_LANGUAGE_CODE,
  normalizeTelegramLanguageCode,
} = require('../utils/telegram-locale');

const LINK_TTL_MS = 10 * 60 * 1000;
const MAX_TELEGRAM_ID = 9223372036854775807n;

class TelegramLinkError extends Error {
  constructor(message, status, code = 'telegram_link_error') {
    super(message);
    this.name = 'TelegramLinkError';
    this.status = status;
    this.code = code;
  }
}

function normalizeTelegramId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  const normalized = String(value ?? '');
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = BigInt(normalized);
  return parsed > 0n && parsed <= MAX_TELEGRAM_ID ? parsed.toString() : null;
}

function createTelegramLinkService(options = {}) {
  const settings = options.settings || config.telegram || {};
  const database = options.database || db;
  const connections = options.connectionModel || connectionModel;
  const inputSessions = options.inputSessionModel || inputSessionModel;
  const linkTokens = options.linkTokenModel || linkTokenModel;
  const profiles = options.profileModel || profileModel;
  const ruleSettings = options.ruleSettingModel || ruleSettingModel;
  const users = options.userModel || User;
  const resolveAccess = options.accessResolver || userAccess.buildResolvedAccessSnapshot;
  const now = options.now || (() => new Date());

  async function requireAccess(user) {
    if (!user?.id || !user.is_active) {
      throw new TelegramLinkError('TrendScope account is unavailable', 403, 'access_denied');
    }
    const access = await resolveAccess(user);
    if (!access?.hasProductAccess) {
      throw new TelegramLinkError('TrendScope access is required', 403, 'access_denied');
    }
    return access;
  }

  function requirePrivateIdentity(input) {
    const telegramUserId = normalizeTelegramId(input.telegramUserId);
    const chatId = normalizeTelegramId(input.chatId);
    if (!telegramUserId || !chatId || telegramUserId !== chatId) {
      throw new TelegramLinkError('Telegram private chat is required', 400, 'private_chat_required');
    }
    return {
      telegramUserId,
      chatId,
      languageCode: normalizeTelegramLanguageCode(input.languageCode),
    };
  }

  function botUrl() {
    const username = String(settings.botUsername || '').replace(/^@/, '');
    return username ? `https://t.me/${username}` : null;
  }

  function serialize(connection) {
    return {
      available: Boolean(settings.enabled && botUrl()),
      status: connection?.status || 'disconnected',
      identity: connection ? {
        username: connection.username || null,
        firstName: connection.first_name || null,
      } : null,
      botUrl: botUrl(),
      linkedAt: connection?.linked_at || null,
      lastDeliveryAt: connection?.last_delivery_at || null,
      lastError: connection?.last_error_code ? {
        code: connection.last_error_code,
        at: connection.last_error_at || null,
      } : null,
    };
  }

  async function getStatus(userId) {
    return serialize(await connections.findActiveByUserId(userId));
  }

  async function createLink(userId) {
    if (!settings.enabled || !botUrl()) {
      throw new TelegramLinkError('Telegram integration is unavailable', 503);
    }

    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const existing = await connections.findActiveByUserId(userId, client);
      if (existing) {
        throw new TelegramLinkError('Disconnect the current Telegram account first', 409);
      }

      await linkTokens.revokeForUser(userId, client);
      const expiresAt = new Date(now().getTime() + LINK_TTL_MS);
      const created = await linkTokens.create({ userId, expiresAt }, client);
      await client.query('COMMIT');
      return {
        deepLink: `${botUrl()}?start=${encodeURIComponent(created.token)}`,
        expiresAt: expiresAt.toISOString(),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function completeLink(input) {
    const token = String(input.token || '').trim();
    const identity = requirePrivateIdentity(input);
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
      throw new TelegramLinkError('Telegram link is invalid or expired', 409, 'invalid_link');
    }

    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const consumed = await linkTokens.consume(token, client);
      if (!consumed) {
        throw new TelegramLinkError('Telegram link is invalid or expired', 409, 'invalid_link');
      }
      const { rows } = await client.query(
        `SELECT id, role, is_active, access_status, access_granted_at,
                access_expires_at, access_source, access_updated_at
         FROM users
         WHERE id = $1
         FOR UPDATE`,
        [consumed.user_id]
      );
      const access = await requireAccess(rows[0]);
      if (await connections.findActiveByUserId(consumed.user_id, client)) {
        throw new TelegramLinkError('TrendScope account is already linked', 409, 'account_already_linked');
      }
      if (await connections.findActiveByTelegramUserId(identity.telegramUserId, client)) {
        throw new TelegramLinkError('Telegram account is already linked', 409, 'telegram_already_linked');
      }
      const connection = await connections.create({
        userId: consumed.user_id,
        ...identity,
        username: input.username,
        firstName: input.firstName,
        languageCode: identity.languageCode || DEFAULT_LANGUAGE_CODE,
      }, client);
      const boundProfiles = await profiles.bindConnection({
        userId: consumed.user_id,
        connectionId: connection.id,
      }, client);
      await ruleSettings.ensureDefaults(boundProfiles, client);
      await client.query('COMMIT');
      return { access, connection };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error?.code === '23505') {
        throw new TelegramLinkError('Telegram account is already linked', 409, 'identity_conflict');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function findAuthorizedConnection(input) {
    const identity = requirePrivateIdentity(input);
    let connection = await connections.findActiveByTelegramUserId(identity.telegramUserId);
    if (!connection || String(connection.chat_id) !== identity.chatId) return null;
    const user = await users.findById(connection.user_id);
    const access = await requireAccess(user);
    if (identity.languageCode && connection.language_code !== identity.languageCode) {
      connection = await connections.updateLanguageCode({
        id: connection.id,
        languageCode: identity.languageCode,
      });
      if (!connection) return null;
    }
    return { access, connection };
  }

  async function disconnect(userId, expected = {}) {
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const existing = await connections.findActiveByUserId(userId, client);
      if (existing && (
        expected.connectionId && String(existing.id) !== String(expected.connectionId)
        || expected.expectedVersion && existing.version !== expected.expectedVersion
      )) {
        throw new TelegramLinkError('Telegram connection changed', 409, 'connection_conflict');
      }
      if (existing) {
        const disconnected = await connections.disconnect(
          existing.id,
          client,
          expected.expectedVersion
        );
        if (expected.expectedVersion && !disconnected) {
          throw new TelegramLinkError('Telegram connection changed', 409, 'connection_conflict');
        }
        await inputSessions.clear({
          userId,
          telegramUserId: existing.telegram_user_id,
        }, client);
      }
      await linkTokens.revokeForUser(userId, client);
      await client.query('COMMIT');
      return serialize(null);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return { completeLink, createLink, disconnect, findAuthorizedConnection, getStatus };
}

module.exports = {
  LINK_TTL_MS,
  TelegramLinkError,
  createTelegramLinkService,
  normalizeTelegramId,
};
