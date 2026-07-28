const db = require('../models/db');
const userConfig = require('../models/user-config');
const userAlertProfileCache = require('./user-alert-profile-cache');

const CHANNEL = 'user_config_invalidated';
const RECONNECT_DELAY_MS = 5 * 1000;
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const RECONCILE_BATCH_SIZE = 1000;

let listenerClient = null;
let listenerOptions = {};
let reconnectTimer = null;
let reconcileTimer = null;
let connectPromise = null;
let running = false;
let listening = false;
let lastError = null;
let receivedNotifications = 0;
let successfulReconnects = 0;
let reconciliations = 0;
let reconciliationErrors = 0;
let checkedProfiles = 0;
let invalidatedProfiles = 0;

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

function buildPayload(userId, version = null, options = {}) {
  const payload = {
    type: 'user_config_invalidated',
    userId: normalizeUserId(userId),
    version: normalizeVersion(version),
  };
  if (options.force === true) payload.force = true;
  return payload;
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
    return buildPayload(parsed.userId, parsed.version, { force: parsed.force === true });
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
  const payload = buildPayload(normalizedUserId, version, options);
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
  cache.invalidateUserProfile(payload.userId, {
    configVersion: payload.version,
    force: payload.force === true,
  });
  receivedNotifications += 1;
  return payload;
}

function detachListener(current) {
  current.client.off?.('notification', current.onNotification);
  current.client.off?.('error', current.onError);
  current.client.off?.('end', current.onEnd);
}

function scheduleReconnect() {
  if (!running || reconnectTimer) return;
  const schedule = listenerOptions.setTimeoutFn || setTimeout;
  const delayMs = Math.max(1, Number(listenerOptions.reconnectDelayMs) || RECONNECT_DELAY_MS);
  reconnectTimer = schedule(() => {
    reconnectTimer = null;
    void connectListener()
      .then(() => { successfulReconnects += 1; })
      .catch((error) => {
        lastError = error?.message || String(error || 'Unknown listener error');
        console.error('[UserConfigSync] reconnect failed:', lastError);
        scheduleReconnect();
      });
  }, delayMs);
  reconnectTimer.unref?.();
}

function disconnectListener(current, error = null) {
  if (listenerClient !== current) return;
  listenerClient = null;
  listening = false;
  detachListener(current);
  try {
    current.client.release?.(error || undefined);
  } catch (_) {}
  if (error) {
    lastError = error?.message || String(error || 'Unknown listener error');
    console.error('[UserConfigSync] listener error:', lastError);
  }
  scheduleReconnect();
}

async function connectListener() {
  if (!running || listenerClient) return getStatus();
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    const pool = listenerOptions.pool || db.pool;
    const client = await pool.connect();
    const current = { client, onNotification: null, onError: null, onEnd: null };
    current.onNotification = (message) => handleNotification(message, listenerOptions);
    current.onError = (error) => disconnectListener(current, error);
    current.onEnd = () => disconnectListener(current);
    client.on('notification', current.onNotification);
    client.on('error', current.onError);
    client.on('end', current.onEnd);
    listenerClient = current;

    try {
      await client.query(`LISTEN ${CHANNEL}`);
    } catch (error) {
      disconnectListener(current, error);
      throw error;
    }

    listening = true;
    lastError = null;
    console.log(`[UserConfigSync] Listening on ${CHANNEL}`);
    return getStatus();
  })();

  try {
    return await connectPromise;
  } finally {
    connectPromise = null;
  }
}

async function reconcileCachedProfiles(options = listenerOptions) {
  const cache = options.profileCache || userAlertProfileCache;
  const model = options.userConfigModel || userConfig;
  const cachedVersions = cache.listCachedProfileVersions();
  const userIds = [...cachedVersions.keys()];
  let checked = 0;
  let invalidated = 0;

  for (let offset = 0; offset < userIds.length; offset += RECONCILE_BATCH_SIZE) {
    const batch = userIds.slice(offset, offset + RECONCILE_BATCH_SIZE);
    const currentVersions = await model.getVersions(batch);
    checked += batch.length;
    invalidated += cache.invalidateProfilesWithDifferentVersions(currentVersions);
  }

  reconciliations += 1;
  checkedProfiles += checked;
  invalidatedProfiles += invalidated;
  return { checked, invalidated };
}

function startReconciliationTimer() {
  if (reconcileTimer) return;
  const schedule = listenerOptions.setIntervalFn || setInterval;
  reconcileTimer = schedule(() => {
    void reconcileCachedProfiles().catch((error) => {
      reconciliationErrors += 1;
      lastError = error?.message || String(error || 'Unknown reconciliation error');
      console.error('[UserConfigSync] reconciliation failed:', lastError);
    });
  }, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref?.();
}

async function start(options = {}) {
  if (!running) {
    running = true;
    listenerOptions = options;
    startReconciliationTimer();
  }
  try {
    return await connectListener();
  } catch (error) {
    lastError = error?.message || String(error || 'Unknown listener error');
    scheduleReconnect();
    throw error;
  }
}

async function stop() {
  running = false;
  const cancelTimeout = listenerOptions.clearTimeoutFn || clearTimeout;
  const cancelInterval = listenerOptions.clearIntervalFn || clearInterval;
  if (reconnectTimer) cancelTimeout(reconnectTimer);
  if (reconcileTimer) cancelInterval(reconcileTimer);
  reconnectTimer = null;
  reconcileTimer = null;
  const current = listenerClient;
  listenerClient = null;
  listening = false;
  if (!current) return;

  detachListener(current);
  try {
    await current.client.query(`UNLISTEN ${CHANNEL}`);
  } catch (_) {}
  current.client.release?.();
}

function getStatus() {
  return {
    channel: CHANNEL,
    running,
    listening,
    receivedNotifications,
    successfulReconnects,
    reconcileIntervalMs: RECONCILE_INTERVAL_MS,
    reconcileBatchSize: RECONCILE_BATCH_SIZE,
    reconciliations,
    reconciliationErrors,
    checkedProfiles,
    invalidatedProfiles,
    lastError,
  };
}

module.exports = {
  CHANNEL,
  RECONCILE_BATCH_SIZE,
  RECONCILE_INTERVAL_MS,
  buildPayload,
  getStatus,
  handleNotification,
  parsePayload,
  publishUserConfigInvalidated,
  reconcileCachedProfiles,
  start,
  stop,
  __private: {
    normalizeUserId,
    normalizeVersion,
    resolveVersion,
  },
};
