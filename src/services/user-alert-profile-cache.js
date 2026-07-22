const userConfig = require('../models/user-config');
const userAlertPresence = require('../models/user-alert-presence');
const config = require('../../config');

const FOREGROUND_TTL_MS = 2 * 60 * 1000;
const HIDDEN_GRACE_MAX_MS = 20 * 60 * 1000;
const PRESENCE_MODES = new Set(['foreground', 'hidden', 'inactive']);

const profileCacheByUserId = new Map();
const alertSessionStartedAtByUserId = new Map();
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

function toTimestampMs(value) {
  if (value == null || value === '') {
    return 0;
  }
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRequiredText(value, fieldName) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  return normalized;
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
    configVersion: options.configVersion || null,
    ruleEnabled: {
      monitoredVol: isEnabled(configs, 'alert-vol-enabled'),
      monitoredMcap: isEnabled(configs, 'alert-mcap-enabled'),
      monitoredFdv: isEnabled(configs, 'alert-fdv-enabled', false),
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
    fdvThresholdPct: getNumber(configs, 'fdv-threshold', 50),
    minVol: getNumber(configs, 'min-vol', 10000),
    minMcap: getNumber(configs, 'min-mcap', 30000),
    maxMcap: getNumber(configs, 'max-mcap', 0),
    minFdv: getNumber(configs, 'monitored-fdv-min', 30000),
    maxFdv: getNumber(configs, 'monitored-fdv-max', 0),
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
      100,
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
      100,
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
    alertSessionStartedAtByUserId.delete(userId);
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

function isPresenceEntryForegroundActive(entry, options = {}) {
  if (!entry || entry.mode !== 'foreground') {
    return false;
  }

  const nowMs = getNowMs(options);
  return Number(entry.foregroundSeenAtMs) > 0
    && (nowMs - entry.foregroundSeenAtMs) <= FOREGROUND_TTL_MS;
}

function isPresenceEntryHiddenActive(entry, options = {}) {
  if (!entry || entry.mode !== 'hidden') {
    return false;
  }

  const nowMs = getNowMs(options);
  return Number(entry.hiddenGraceUntilMs) > nowMs;
}

function listActivePresenceEntriesForUser(userId, options = {}) {
  const normalizedUserId = normalizeUserId(userId);
  const nowMs = getNowMs(options);
  const socketIds = socketIdsByUserId.get(normalizedUserId);
  if (!socketIds || socketIds.size === 0) {
    return [];
  }

  const entries = [];
  for (const socketId of socketIds) {
    const entry = livePresenceBySocketId.get(socketId);
    if (!entry || !isPresenceEntryActive(entry, { nowMs })) {
      continue;
    }
    entries.push({ ...entry });
  }

  return entries;
}

function getActivePresenceContextForUser(userId, options = {}) {
  const nowMs = getNowMs(options);
  const entries = listActivePresenceEntriesForUser(userId, { nowMs });
  if (entries.length === 0) {
    return null;
  }

  if (entries.some((entry) => isPresenceEntryForegroundActive(entry, { nowMs }))) {
    return {
      mode: 'foreground',
      hiddenSessionKey: null,
      hiddenStartedAtMs: null,
    };
  }

  const hiddenEntries = entries.filter((entry) => isPresenceEntryHiddenActive(entry, { nowMs }));
  if (hiddenEntries.length === 0) {
    return null;
  }

  const hiddenStartedAtMs = Math.min(...hiddenEntries.map((entry) => {
    const startedAtMs = Number(entry.hiddenStartedAtMs);
    return Number.isFinite(startedAtMs) && startedAtMs > 0
      ? startedAtMs
      : Number(entry.updatedAtMs) || nowMs;
  }));

  return {
    mode: 'hidden',
    hiddenSessionKey: `hidden:${hiddenStartedAtMs}`,
    hiddenStartedAtMs,
  };
}

function upsertLivePresence(userId, socketId, payload = {}, options = {}) {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedSocketId = normalizeSocketId(socketId);
  const normalizedPresence = normalizePresencePayload(payload);
  const nowMs = getNowMs(options);
  const current = livePresenceBySocketId.get(normalizedSocketId) || null;
  const hiddenStartedAtMs = normalizedPresence.mode === 'hidden'
    ? (
      current?.mode === 'hidden'
      && Number(current.hiddenStartedAtMs) > 0
        ? Number(current.hiddenStartedAtMs)
        : nowMs
    )
    : 0;
  const nextEntry = {
    userId: normalizedUserId,
    socketId: normalizedSocketId,
    workspace: normalizedPresence.workspace,
    mode: normalizedPresence.mode,
    foregroundSeenAtMs: normalizedPresence.mode === 'foreground' ? nowMs : 0,
    hiddenStartedAtMs,
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

function shouldUseSharedPresence(options = {}) {
  if (options.sharedPresence === true) {
    return true;
  }
  if (options.sharedPresence === false) {
    return false;
  }
  if (options.sharedPresenceModel || options.sharedPresenceRows) {
    return true;
  }
  return Boolean(config.runtime?.runBackgroundJobs) && !config.runtime?.runSocketHub;
}

function getCachedUserProfile(userId) {
  const normalizedUserId = normalizeUserId(userId);
  return profileCacheByUserId.get(normalizedUserId) || null;
}

async function refreshUserProfile(userId) {
  const normalizedUserId = normalizeUserId(userId);
  const configResult = typeof userConfig.getAllWithStoredKeys === 'function'
    ? await userConfig.getAllWithStoredKeys(normalizedUserId)
    : { configs: await userConfig.getAll(normalizedUserId), storedKeys: [] };
  const profile = buildNormalizedAlertProfile(normalizedUserId, configResult.configs, {
    configVersion: configResult.configVersion,
    storedKeys: configResult.storedKeys,
  });
  profileCacheByUserId.set(normalizedUserId, profile);
  return profile;
}

function shouldInvalidateProfile(profile, options = {}) {
  const incomingVersionMs = toTimestampMs(options.configVersion);
  if (!incomingVersionMs || !profile?.configVersion) {
    return true;
  }

  const cachedVersionMs = toTimestampMs(profile.configVersion);
  return !cachedVersionMs || incomingVersionMs > cachedVersionMs;
}

function invalidateUserProfile(userId, options = {}) {
  const normalizedUserId = normalizeUserId(userId);
  const current = profileCacheByUserId.get(normalizedUserId) || null;
  if (current && !shouldInvalidateProfile(current, options)) {
    return false;
  }

  profileCacheByUserId.delete(normalizedUserId);
  return Boolean(current);
}

function listCachedProfileVersions() {
  return new Map([...profileCacheByUserId.entries()]
    .map(([userId, profile]) => [userId, profile?.configVersion || null]));
}

function invalidateProfilesWithDifferentVersions(versionsByUserId) {
  let invalidated = 0;
  for (const [userId, configVersion] of versionsByUserId || []) {
    const profile = profileCacheByUserId.get(normalizeUserId(userId));
    if (!profile || toTimestampMs(profile.configVersion) === toTimestampMs(configVersion)) continue;
    profileCacheByUserId.delete(normalizeUserId(userId));
    invalidated += 1;
  }
  return invalidated;
}

function pruneInactiveProfiles(activeUserIds) {
  const activeSet = new Set(activeUserIds);
  for (const userId of profileCacheByUserId.keys()) {
    if (!activeSet.has(userId)) profileCacheByUserId.delete(userId);
  }
}

function syncAlertSessionStarts(activeUserIds, nowMs) {
  const activeSet = new Set(activeUserIds);
  for (const userId of alertSessionStartedAtByUserId.keys()) {
    if (!activeSet.has(userId)) alertSessionStartedAtByUserId.delete(userId);
  }
  for (const userId of activeSet) {
    if (!alertSessionStartedAtByUserId.has(userId)) {
      alertSessionStartedAtByUserId.set(userId, nowMs);
    }
  }
}

function getAlertSessionStartedAt(userId) {
  const startedAtMs = Number(alertSessionStartedAtByUserId.get(userId));
  return Number.isFinite(startedAtMs) ? new Date(startedAtMs).toISOString() : null;
}

function getSharedPresenceUserId(row) {
  const userId = Number.parseInt(String(row?.userId || row?.user_id || '').trim(), 10);
  return Number.isInteger(userId) && userId > 0 ? userId : null;
}

function getSharedPresenceSessionKey(row) {
  return String(row?.sessionKey || row?.session_key || '').trim() || null;
}

function getSharedPresenceHiddenStartedAtMs(row, nowMs) {
  return toTimestampMs(row.hiddenStartedAt || row.hidden_started_at)
    || toTimestampMs(row.lastHeartbeatAt || row.last_heartbeat_at)
    || nowMs;
}

function mergeSharedPresenceContext(current, row, mode, activeUntilMs, nowMs) {
  const next = current || {
    userId: getSharedPresenceUserId(row),
    mode: 'hidden',
    hiddenStartedAtMs: null,
    activeUntilMs,
    sessionKeys: new Set(),
  };
  const sessionKey = getSharedPresenceSessionKey(row);
  if (sessionKey) next.sessionKeys.add(sessionKey);
  next.activeUntilMs = Math.min(Number(next.activeUntilMs) || activeUntilMs, activeUntilMs);

  if (mode === 'foreground') {
    next.mode = 'foreground';
    next.hiddenStartedAtMs = null;
    return next;
  }

  if (next.mode !== 'foreground') {
    const hiddenStartedAtMs = getSharedPresenceHiddenStartedAtMs(row, nowMs);
    next.hiddenStartedAtMs = next.hiddenStartedAtMs == null
      ? hiddenStartedAtMs
      : Math.min(next.hiddenStartedAtMs, hiddenStartedAtMs);
  }

  return next;
}

function getAlertSessionKey(context) {
  const keys = [...(context?.sessionKeys || [])].sort();
  return keys.length > 0 ? keys.join('|') : null;
}

function buildSharedPresenceContexts(rows = [], options = {}) {
  const nowMs = getNowMs(options);
  const byUserId = new Map();

  for (const row of rows) {
    const userId = getSharedPresenceUserId(row);
    if (!userId) {
      continue;
    }

    const mode = normalizeMode(row.mode);
    if (mode === 'inactive') {
      continue;
    }

    const activeUntilMs = toTimestampMs(row.activeUntilAt || row.active_until_at);
    if (activeUntilMs <= nowMs) {
      continue;
    }

    byUserId.set(
      userId,
      mergeSharedPresenceContext(byUserId.get(userId), row, mode, activeUntilMs, nowMs)
    );
  }

  return byUserId;
}

async function listSharedPresenceContexts(options = {}, nowMs = getNowMs(options)) {
  const rows = Array.isArray(options.sharedPresenceRows)
    ? options.sharedPresenceRows
    : await (options.sharedPresenceModel || userAlertPresence).listActive(
      {},
      { now: new Date(nowMs) },
      options.db
    );
  return buildSharedPresenceContexts(rows, { nowMs });
}

async function upsertSharedLivePresence(userId, socketId, payload = {}, options = {}) {
  const normalizedPresence = normalizePresencePayload(payload);
  return (options.sharedPresenceModel || userAlertPresence).upsert({
    userId: normalizeUserId(userId),
    sessionKey: normalizeRequiredText(options.sessionKey, 'Session key'),
    socketId: normalizeSocketId(socketId),
    webInstanceId: normalizeRequiredText(options.webInstanceId, 'Web instance id'),
    mode: normalizedPresence.mode,
    hiddenGraceMs: normalizedPresence.hiddenGraceMs,
  }, options, options.db);
}

async function clearSharedLivePresence(socketId, options = {}) {
  return (options.sharedPresenceModel || userAlertPresence).disconnect({
    socketId: normalizeSocketId(socketId),
    webInstanceId: normalizeRequiredText(options.webInstanceId, 'Web instance id'),
  }, options, options.db);
}

async function listSharedActiveProfiles(options, nowMs) {
  const contextsByUserId = await listSharedPresenceContexts(options, nowMs);
  const activeUserIds = [...contextsByUserId.keys()].sort((a, b) => a - b);
  syncAlertSessionStarts(activeUserIds, nowMs);
  pruneInactiveProfiles(activeUserIds);
  const missingUserIds = activeUserIds.filter((userId) => !getCachedUserProfile(userId));

  if (missingUserIds.length > 0) {
    await Promise.all(missingUserIds.map((userId) => refreshUserProfile(userId)));
  }

  return activeUserIds
    .map((userId) => {
      const profile = getCachedUserProfile(userId);
      const presence = contextsByUserId.get(userId);
      if (!profile || !presence) {
        return null;
      }

      return {
        ...profile,
        loadedAt: getAlertSessionStartedAt(userId) || profile.loadedAt,
        alertSessionKey: getAlertSessionKey(presence),
        presenceMode: presence.mode,
        hiddenSessionKey: presence.mode === 'hidden' && presence.hiddenStartedAtMs
          ? `hidden:${presence.hiddenStartedAtMs}`
          : null,
        hiddenStartedAt: presence.mode === 'hidden' && presence.hiddenStartedAtMs
          ? new Date(presence.hiddenStartedAtMs).toISOString()
          : null,
      };
    })
    .filter(Boolean);
}

async function listLocalActiveProfiles(options, nowMs) {
  const activeUserIds = listActiveUserIds(options);
  syncAlertSessionStarts(activeUserIds, nowMs);
  const missingUserIds = activeUserIds.filter((userId) => !getCachedUserProfile(userId, { nowMs }));

  if (missingUserIds.length > 0) {
    await Promise.all(missingUserIds.map((userId) => refreshUserProfile(userId)));
  }

  return activeUserIds
    .map((userId) => {
      const profile = getCachedUserProfile(userId, { nowMs });
      if (!profile) {
        return null;
      }

      const presence = getActivePresenceContextForUser(userId, { nowMs });
      return {
        ...profile,
        loadedAt: getAlertSessionStartedAt(userId) || profile.loadedAt,
        presenceMode: presence?.mode || null,
        hiddenSessionKey: presence?.hiddenSessionKey || null,
        hiddenStartedAt: presence?.hiddenStartedAtMs
          ? new Date(presence.hiddenStartedAtMs).toISOString()
          : null,
      };
    })
    .filter(Boolean);
}

async function listActiveProfiles(options = {}) {
  const nowMs = getNowMs(options);
  return shouldUseSharedPresence(options)
    ? listSharedActiveProfiles(options, nowMs)
    : listLocalActiveProfiles(options, nowMs);
}

function getStatus(options = {}) {
  return {
    foregroundTtlMs: FOREGROUND_TTL_MS,
    hiddenGraceMaxMs: HIDDEN_GRACE_MAX_MS,
    profileCacheStrategy: 'event-driven',
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
  clearSharedLivePresence,
  clearLivePresence,
  getStatus,
  invalidateUserProfile,
  invalidateProfilesWithDifferentVersions,
  isPresenceEntryActive,
  listActiveProfiles,
  listActiveUserIds,
  listCachedProfileVersions,
  refreshUserProfile,
  upsertSharedLivePresence,
  upsertLivePresence,
  __private: {
    buildSharedPresenceContexts,
    getSharedPresenceHiddenStartedAtMs,
    getSharedPresenceSessionKey,
    getSharedPresenceUserId,
    getActivePresenceContextForUser,
    getCachedUserProfile,
    getNowMs,
    getNumber,
    isEnabled,
    isPresenceEntryForegroundActive,
    isPresenceEntryHiddenActive,
    listActivePresenceEntriesForUser,
    normalizeHiddenGraceMs,
    normalizeMode,
    normalizePresencePayload,
    normalizeRequiredText,
    shouldInvalidateProfile,
    shouldUseSharedPresence,
    normalizeSocketId,
    normalizeStoredKeys,
    normalizeUserId,
    alertSessionStartedAtByUserId,
    profileCacheByUserId,
    livePresenceBySocketId,
    resolveEnabledWithFallback,
    resolveNumberWithFallback,
    socketIdsByUserId,
    syncAlertSessionStarts,
    trackSocketForUser,
    untrackSocketForUser,
  },
};
