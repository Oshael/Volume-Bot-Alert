const db = require('../models/db');
const userConfig = require('../models/user-config');
const userAlertProfileCache = require('./user-alert-profile-cache');

const CHANNEL = 'user_config_invalidated';

let listenerClient = null;
let listening = false;
let lastError = null;
let receivedNotifications = 0;

function normalizeUserId(value) {
  const userId = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('Valid user id is required');
  }
  return userId;
}

function normalizeVersion(value) {
  if (value == null || value === '') {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function buildPayload(userId, version = null) {
  return {
    type: 'user_config_invalidated',
    userId: normalizeUserId(userId),
    version: normalizeVersion(version),
  };
}

function parsePayload(rawPayload) {
  let parsed;
  try {
    parsed = JSON.parse(String(rawPayload || '{}'));
  } catch (_) {
    return null;
  }

  if (parsed?.type !== 'user_config_invalidated') {
    return null;
  }

  try {
    return buildPayload(parsed.userId, parsed.version);
  } catch (_) {
    return null;
  }
}

async function resolveVersion(userId, options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'version')) {
    return normalizeVersion(options.version);
  }

  const model = options.userConfigModel || userConfig;
  return typeof model.getVersion === 'function'
    ? model.getVersion(userId)
    : null;
}

async function publishUserConfigInvalidated(userId, options = {}) {
  const normalizedUserId = normalizeUserId(userId);
  const version = await resolveVersion(normalizedUserId, options);
  const payload = buildPayload(normalizedUserId, version);
  const runner = options.db && typeof options.db.query === 'function' ? options.db : db;

  await runner.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify(payload)]);
  return payload;
}

function handleNotification(message, options = {}) {
  if (message?.channel !== CHANNEL) {
    return null;
  }

  const payload = parsePayload(message.payload);
  if (!payload) {
    return null;
  }

  const cache = options.profileCache || userAlertProfileCache;
  cache.invalidateUserProfile(payload.userId, { configVersion: payload.version });
  receivedNotifications += 1;
  return payload;
}

async function start(options = {}) {
  if (listenerClient) {
    return getStatus();
  }

  const pool = options.pool || db.pool;
  const client = await pool.connect();
  const onNotification = (message) => {
    handleNotification(message, options);
  };
  const onError = (error) => {
    lastError = error?.message || String(error || 'Unknown listener error');
    console.error('[UserConfigSync] listener error:', lastError);
  };
  const onEnd = () => {
    listening = false;
    listenerClient = null;
  };

  client.on('notification', onNotification);
  client.on('error', onError);
  client.on('end', onEnd);
  await client.query(`LISTEN ${CHANNEL}`);
  listenerClient = {
    client,
    onNotification,
    onError,
    onEnd,
  };
  listening = true;
  lastError = null;
  console.log(`[UserConfigSync] Listening on ${CHANNEL}`);
  return getStatus();
}

async function stop() {
  const current = listenerClient;
  if (!current) {
    return;
  }

  listenerClient = null;
  listening = false;
  current.client.off?.('notification', current.onNotification);
  current.client.off?.('error', current.onError);
  current.client.off?.('end', current.onEnd);
  try {
    await current.client.query(`UNLISTEN ${CHANNEL}`);
  } catch (_) {}
  current.client.release?.();
}

function getStatus() {
  return {
    channel: CHANNEL,
    listening,
    receivedNotifications,
    lastError,
  };
}

module.exports = {
  CHANNEL,
  buildPayload,
  getStatus,
  handleNotification,
  parsePayload,
  publishUserConfigInvalidated,
  start,
  stop,
  __private: {
    normalizeUserId,
    normalizeVersion,
    resolveVersion,
  },
};
