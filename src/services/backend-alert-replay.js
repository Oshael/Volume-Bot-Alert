const alertDeliveryCursor = require('../models/alert-delivery-cursor');
const userAlertPresence = require('../models/user-alert-presence');
const userAlertEvent = require('../models/user-alert-event');
const { listBackendAlertRules } = require('./backend-alert-rules');
const backendAlertRealtime = require('./backend-alert-realtime');

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const replayInFlightByUserId = new Map();

function normalizePositiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function getReplayableRules(options = {}) {
  const listRules = options.listBackendAlertRules || listBackendAlertRules;
  return listRules({ dashboardFeedEnabled: true })
    .filter((rule) => (
      rule
      && rule.scope === 'user-token'
      && rule.historicalReplayEnabled !== false
    ));
}

function getUserReplayKey(userId) {
  const normalizedUserId = normalizePositiveInteger(userId, null);
  return normalizedUserId ? `user:${normalizedUserId}` : null;
}

function resolveReplayDependencies(options = {}) {
  return {
    cursorModel: options.alertDeliveryCursor || alertDeliveryCursor,
    presenceModel: options.userAlertPresenceModel || userAlertPresence,
    eventModel: options.userAlertEventModel || userAlertEvent,
    realtime: options.backendAlertRealtime || backendAlertRealtime,
    pageLimit: normalizePositiveInteger(options.pageLimit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
  };
}

async function hasActivePresenceForReplay(userId, options = {}) {
  if (options.requireActivePresence === false) {
    return true;
  }

  const { presenceModel } = resolveReplayDependencies(options);
  const rows = await presenceModel.listActive(
    { userId },
    options.now ? { now: options.now } : {},
    options.db
  );
  return rows.length > 0;
}

async function bootstrapRuleCursorToLatest(userId, rule, options = {}) {
  const {
    cursorModel,
    eventModel,
  } = resolveReplayDependencies(options);
  const latestEventId = await eventModel.getLatestEventId({
    userId,
    ruleKey: rule.ruleKey,
  });

  if (!latestEventId) {
    return {
      ruleKey: rule.ruleKey,
      bootstrapped: false,
      lastSeenEventId: null,
    };
  }

  const cursor = await cursorModel.markSeen(userId, rule.ruleKey, latestEventId);
  return {
    ruleKey: rule.ruleKey,
    bootstrapped: true,
    lastSeenEventId: cursor?.lastSeenEventId || latestEventId,
  };
}

async function bootstrapUserCursorToLatest(userId, options = {}) {
  const normalizedUserId = normalizePositiveInteger(userId, null);
  if (!normalizedUserId) {
    throw new Error('Valid user id is required');
  }

  const rules = getReplayableRules(options);
  const results = [];
  for (const rule of rules) {
    results.push(await bootstrapRuleCursorToLatest(normalizedUserId, rule, options));
  }

  return {
    userId: normalizedUserId,
    rules: results.length,
    bootstrapped: results.filter((item) => item.bootstrapped).length,
    results,
  };
}

function buildReplayPayload(realtime, userId, eventId) {
  return {
    type: realtime.USER_ALERT_PAYLOAD_TYPE || realtime.PAYLOAD_TYPE,
    eventId,
    userId,
  };
}

async function listReplayPage(eventModel, userId, ruleKey, afterId, pageLimit) {
  return eventModel.listRecentEvents({
    userId,
    ruleKey,
    afterId,
    sort: 'asc',
    limit: pageLimit,
  });
}

async function emitReplayPage(events, userId, realtime, afterId) {
  let emitted = 0;
  let highestEventId = afterId || 0;

  for (const event of events) {
    const eventId = normalizePositiveInteger(event?.id, null);
    if (!eventId) {
      continue;
    }

    await realtime.emitPersistedEvent(buildReplayPayload(realtime, userId, eventId));
    emitted += 1;
    highestEventId = Math.max(highestEventId, eventId);
  }

  return { emitted, highestEventId };
}

async function replayRuleEvents(userId, rule, options = {}) {
  const {
    cursorModel,
    eventModel,
    realtime,
    pageLimit,
  } = resolveReplayDependencies(options);
  let cursor = await cursorModel.getCursor(userId, rule.ruleKey);
  let afterId = cursor?.lastSeenEventId || null;
  let emitted = 0;
  let pages = 0;

  while (true) {
    const events = await listReplayPage(eventModel, userId, rule.ruleKey, afterId, pageLimit);
    if (!events.length) {
      break;
    }

    pages += 1;
    const pageResult = await emitReplayPage(events, userId, realtime, afterId);
    emitted += pageResult.emitted;

    if (!pageResult.highestEventId || pageResult.highestEventId === afterId) {
      break;
    }

    cursor = await cursorModel.markSeen(userId, rule.ruleKey, pageResult.highestEventId);
    afterId = cursor?.lastSeenEventId || pageResult.highestEventId;

    if (events.length < pageLimit) {
      break;
    }
  }

  return {
    ruleKey: rule.ruleKey,
    emitted,
    pages,
    lastSeenEventId: afterId,
  };
}

async function replayUserBacklog(userId, options = {}) {
  const normalizedUserId = normalizePositiveInteger(userId, null);
  if (!normalizedUserId) {
    throw new Error('Valid user id is required');
  }

  const rules = getReplayableRules(options);
  const results = [];
  for (const rule of rules) {
    results.push(await replayRuleEvents(normalizedUserId, rule, options));
  }

  return {
    userId: normalizedUserId,
    rules: results.length,
    emitted: results.reduce((sum, item) => sum + item.emitted, 0),
    pages: results.reduce((sum, item) => sum + item.pages, 0),
    results,
  };
}

function replayForSocket(socket, options = {}) {
  const userId = normalizePositiveInteger(socket?.user?.id, null);
  const replayKey = getUserReplayKey(userId);

  if (!replayKey) {
    return Promise.resolve({ started: false, reason: 'invalid_user' });
  }

  if (replayInFlightByUserId.has(userId)) {
    return Promise.resolve({
      started: false,
      reason: 'replay_in_flight',
      replayKey,
    });
  }

  const promise = hasActivePresenceForReplay(userId, options)
    .then((active) => (
      active
        ? replayUserBacklog(userId, options)
        : bootstrapUserCursorToLatest(userId, options).then((result) => ({
          ...result,
          emitted: 0,
          pages: 0,
          skippedReplay: true,
          reason: 'inactive_presence',
        }))
    ))
    .then((result) => ({
      started: true,
      replayKey,
      ...result,
    }))
    .catch((error) => {
      console.error('[BackendAlertReplay] Failed to replay alert backlog:', error.message);
      return {
        started: true,
        replayKey,
        error: error.message,
      };
    })
    .finally(() => {
      if (replayInFlightByUserId.get(userId) === promise) {
        replayInFlightByUserId.delete(userId);
      }
    });

  replayInFlightByUserId.set(userId, promise);
  return promise;
}

module.exports = {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  bootstrapUserCursorToLatest,
  replayForSocket,
  replayRuleEvents,
  replayUserBacklog,
  __private: {
    bootstrapRuleCursorToLatest,
    buildReplayPayload,
    emitReplayPage,
    getReplayableRules,
    getUserReplayKey,
    hasActivePresenceForReplay,
    listReplayPage,
    normalizePositiveInteger,
    resolveReplayDependencies,
  },
};
