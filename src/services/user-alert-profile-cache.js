const userConfig = require('../models/user-config');

const FOREGROUND_TTL_MS = 45 * 1000;
const HIDDEN_GRACE_MAX_MS = 20 * 60 * 1000;
const PRESENCE_MODES = new Set(['foreground', 'hidden', 'inactive']);

const profileCacheByUserId = new Map();
const livePresenceBySocketId = new Map();
const socketIdsByUserId = new Map();

function normalizeUserId(value) {
  const userId = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('Valid user id is required');
  }
  return userId;
}

function normalizeSocketId(value) {
  const socketId = String(value || '').trim();
  if (!socketId) {
    throw new Error('Socket id is required');
  }
  return socketId;
}

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return PRESENCE_MODES.has(mode) ? mode : 'inactive';
}

function normalizeHiddenGraceMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return HIDDEN_GRACE_MAX_MS;
  }

  return Math.max(1, Math.min(Math.trunc(parsed), HIDDEN_GRACE_MAX_MS));
}

function getNowMs(options = {}) {
  const nowMs = Number(options.nowMs);
  return Number.isFinite(nowMs) ? nowMs : Date.now();
}

function isEnabled(configs, key, fallback = true) {
  return String(configs?.[key] ?? (fallback ? 'on' : 'off')).trim().toLowerCase() !== 'off';
}

function getNumber(configs, key, fallback) {
  const parsed = Number(configs?.[key]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeStoredKeys(input) {
  if (input instanceof Set) {
    return new Set([...input].map((key) => String(key)));
  }

  if (Array.isArray(input)) {
    return new Set(input.map((key) => String(key)));
  }

  if (input && typeof input === 'object') {
    return new Set(Object.keys(input));
  }

  return new Set();
}

function resolveEnabledWithFallback(configs, storedKeys, primaryKey, legacyKey, fallback = true) {
  if (storedKeys.has(primaryKey)) {
    return isEnabled(configs, primaryKey, fallback);
  }
  return isEnabled(configs, legacyKey, fallback);
}

function resolveNumberWithFallback(configs, storedKeys, primaryKey, legacyKey, fallback) {
  if (storedKeys.has(primaryKey)) {
    return getNumber(configs, primaryKey, fallback);
  }
  return getNumber(configs, legacyKey, fallback);
}

function buildNormalizedAlertProfile(userId, configs = {}, options = {}) {
  const storedKeys = normalizeStoredKeys(options.storedKeys || configs);

  return {
    userId,
    source: 'user_config',
    ruleEnabled: {
      monitoredVol: isEnabled(configs, 'alert-vol-enabled'),
      monitoredMcap: isEnabled(configs, 'alert-mcap-enabled'),
      hvnc: isEnabled(configs, 'alert-hvnc-enabled'),
      recentSurge1h: resolveEnabledWithFallback(
        configs,
        storedKeys,
        'alert-recent-surge-1h-enabled',
        'alert-old-surge-1h-enabled',
      ),
      recentSurge6h: resolveEnabledWithFallback(
        configs,
        storedKeys,
        'alert-recent-surge-6h-enabled',
        'alert-old-surge-6h-enabled',
      ),
      oldWeekSurge1h: resolveEnabledWithFallback(
        configs,
        storedKeys,
        'alert-old-week-surge-1h-enabled',
        'alert-old-surge-1h-enabled',
      ),
      oldWeekSurge6h: resolveEnabledWithFallback(
        configs,
        storedKeys,
        'alert-old-week-surge-6h-enabled',
        'alert-old-surge-6h-enabled',
      ),
      meteoraSurge: isEnabled(configs, 'alert-meteora-surge-enabled'),
    },
    thresholdPct: getNumber(configs, 'threshold', 50),
    mcapThresholdPct: getNumber(configs, 'mcap-threshold', 50),
    minVol: getNumber(configs, 'min-vol', 8000),
    minMcap: getNumber(configs, 'min-mcap', 30000),
    maxMcap: getNumber(configs, 'max-mcap', 0),
    hvncMinVol: getNumber(configs, 'hvnc-min-vol', 300000),
    recentSurge1hThresholdPct: resolveNumberWithFallback(
      configs,
      storedKeys,
      'recent-surge-1h-threshold',
      'old-alert-1h-threshold',
      50,
    ),
    recentSurge6hThresholdPct: resolveNumberWithFallback(
      configs,
      storedKeys,
      'recent-surge-6h-threshold',
      'old-alert-6h-threshold',
      150,
    ),
    oldWeekSurge1hThresholdPct: resolveNumberWithFallback(
      configs,
      storedKeys,
      'old-week-surge-1h-threshold',
      'old-alert-1h-threshold',
      50,
    ),
    oldWeekSurge6hThresholdPct: resolveNumberWithFallback(
      configs,
      storedKeys,
      'old-week-surge-6h-threshold',
      'old-alert-6h-threshold',
      150,
    ),
    meteoraAlert1hThreshold: getNumber(configs, 'meteora-alert-1h-threshold', 50),
    loadedAt: new Date().toISOString(),
  };
}

function trackSocketForUser(userId, socketId) {
  let socketIds = socketIdsByUserId.get(userId);
  if (!socketIds) {
    socketIds = new Set();
    socketIdsByUserId.set(userId, socketIds);
  }

  socketIds.add(socketId);
}

function untrackSocketForUser(userId, socketId) {
  const socketIds = socketIdsByUserId.get(userId);
  if (!socketIds) {
    return;
  }

  socketIds.delete(socketId);
  if (socketIds.size === 0) {
    socketIdsByUserId.delete(userId);
    profileCacheByUserId.delete(userId);
  }
}

function normalizePresencePayload(payload = {}) {
  const workspace = String(payload.workspace || '').trim().toLowerCase();
  if (workspace && workspace !== 'live') {
    throw new Error('Unsupported workspace for alert presence');
  }

  const mode = normalizeMode(payload.mode);
  return {
    workspace: 'live',
    mode,
    hiddenGraceMs: mode === 'hidden'
      ? normalizeHiddenGraceMs(payload.hiddenGraceMs)
      : 0,
  };
}

function isPresenceEntryActive(entry, options = {}) {
  if (!entry || entry.mode === 'inactive') {
    return false;
  }

  const nowMs = getNowMs(options);
  const foregroundStillFresh = entry.mode === 'foreground'
    && Number(entry.foregroundSeenAtMs) > 0
    && (nowMs - entry.foregroundSeenAtMs) <= FOREGROUND_TTL_MS;
  const hiddenGraceStillValid = Number(entry.hiddenGraceUntilMs) > nowMs;

  return foregroundStillFresh || hiddenGraceStillValid;
}

function upsertLivePresence(userId, socketId, payload = {}, options = {}) {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedSocketId = normalizeSocketId(socketId);
  const normalizedPresence = normalizePresencePayload(payload);
  const nowMs = getNowMs(options);
  const nextEntry = {
    userId: normalizedUserId,
    socketId: normalizedSocketId,
    workspace: normalizedPresence.workspace,
    mode: normalizedPresence.mode,
    foregroundSeenAtMs: normalizedPresence.mode === 'foreground' ? nowMs : 0,
    hiddenGraceUntilMs: normalizedPresence.mode === 'hidden'
      ? nowMs + normalizedPresence.hiddenGraceMs
      : 0,
    updatedAtMs: nowMs,
  };

  trackSocketForUser(normalizedUserId, normalizedSocketId);
  livePresenceBySocketId.set(normalizedSocketId, nextEntry);
  return { ...nextEntry };
}

function clearLivePresence(socketId) {
  const normalizedSocketId = normalizeSocketId(socketId);
  const current = livePresenceBySocketId.get(normalizedSocketId) || null;
  if (!current) {
    return null;
  }

  livePresenceBySocketId.delete(normalizedSocketId);
  untrackSocketForUser(current.userId, normalizedSocketId);
  return { ...current };
}

function listActiveUserIds(options = {}) {
  const nowMs = getNowMs(options);
  const activeUserIds = [];

  for (const [userId, socketIds] of socketIdsByUserId.entries()) {
    for (const socketId of socketIds) {
      const entry = livePresenceBySocketId.get(socketId);
      if (!entry) {
        continue;
      }

      if (isPresenceEntryActive(entry, { nowMs })) {
        activeUserIds.push(userId);
        break;
      }
    }
  }

  return activeUserIds.sort((a, b) => a - b);
}

async function refreshUserProfile(userId) {
  const normalizedUserId = normalizeUserId(userId);
  const configResult = typeof userConfig.getAllWithStoredKeys === 'function'
    ? await userConfig.getAllWithStoredKeys(normalizedUserId)
    : { configs: await userConfig.getAll(normalizedUserId), storedKeys: [] };
  const profile = buildNormalizedAlertProfile(normalizedUserId, configResult.configs, {
    storedKeys: configResult.storedKeys,
  });
  profileCacheByUserId.set(normalizedUserId, profile);
  return profile;
}

function invalidateUserProfile(userId) {
  profileCacheByUserId.delete(normalizeUserId(userId));
}

async function listActiveProfiles(options = {}) {
  const activeUserIds = listActiveUserIds(options);
  const missingUserIds = activeUserIds.filter((userId) => !profileCacheByUserId.has(userId));

  if (missingUserIds.length > 0) {
    await Promise.all(missingUserIds.map((userId) => refreshUserProfile(userId)));
  }

  return activeUserIds
    .map((userId) => profileCacheByUserId.get(userId) || null)
    .filter(Boolean);
}

function getStatus(options = {}) {
  return {
    foregroundTtlMs: FOREGROUND_TTL_MS,
    hiddenGraceMaxMs: HIDDEN_GRACE_MAX_MS,
    trackedSockets: livePresenceBySocketId.size,
    trackedUsers: socketIdsByUserId.size,
    activeUsers: listActiveUserIds(options).length,
    cachedProfiles: profileCacheByUserId.size,
  };
}

module.exports = {
  FOREGROUND_TTL_MS,
  HIDDEN_GRACE_MAX_MS,
  PRESENCE_MODES,
  buildNormalizedAlertProfile,
  clearLivePresence,
  getStatus,
  invalidateUserProfile,
  isPresenceEntryActive,
  listActiveProfiles,
  listActiveUserIds,
  refreshUserProfile,
  upsertLivePresence,
  __private: {
    getNowMs,
    getNumber,
    isEnabled,
    normalizeHiddenGraceMs,
    normalizeMode,
    normalizePresencePayload,
    normalizeSocketId,
    normalizeStoredKeys,
    normalizeUserId,
    profileCacheByUserId,
    livePresenceBySocketId,
    resolveEnabledWithFallback,
    resolveNumberWithFallback,
    socketIdsByUserId,
    trackSocketForUser,
    untrackSocketForUser,
  },
};
