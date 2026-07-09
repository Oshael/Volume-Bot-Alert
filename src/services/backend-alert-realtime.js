const db = require('../models/db');
const gmgnClaimAlertEvent = require('../models/gmgn-claim-alert-event');
const userAlertEvent = require('../models/user-alert-event');
const { GMGN_CLAIM_SIGNAL_RULE_KEY } = require('./backend-alert-rules');
const backendAlertFeed = require('./backend-alert-feed');
const socketHub = require('./socket-hub');

const CHANNEL = 'backend_alert_event_created';
const USER_ALERT_PAYLOAD_TYPE = 'user_alert_event_created';
const GLOBAL_ALERT_PAYLOAD_TYPE = 'global_alert_event_created';

let listenerClient = null;
let listening = false;
let lastError = null;
const stats = {
  published: 0,
  publishFailures: 0,
  received: 0,
  emitted: 0,
  skipped: 0,
  errors: 0,
};

function normalizePositiveInteger(value, fieldName) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} is required`);
  }
  return parsed;
}

function getPayloadType(eventRow) {
  return eventRow?.userId == null ? GLOBAL_ALERT_PAYLOAD_TYPE : USER_ALERT_PAYLOAD_TYPE;
}

function buildPayload(eventRow) {
  const type = getPayloadType(eventRow);
  return {
    type,
    eventId: normalizePositiveInteger(eventRow?.id, 'Alert event id'),
    userId: type === USER_ALERT_PAYLOAD_TYPE
      ? normalizePositiveInteger(eventRow?.userId, 'Alert event user id')
      : null,
  };
}

function parsePayload(rawPayload) {
  let parsed;
  try {
    parsed = JSON.parse(String(rawPayload || '{}'));
  } catch (_) {
    return null;
  }

  if (![USER_ALERT_PAYLOAD_TYPE, GLOBAL_ALERT_PAYLOAD_TYPE].includes(parsed?.type)) {
    return null;
  }

  try {
    return buildPayload({
      id: parsed.eventId,
      userId: parsed.type === USER_ALERT_PAYLOAD_TYPE ? parsed.userId : null,
    });
  } catch (_) {
    return null;
  }
}

async function publishEventCreated(eventRow, options = {}) {
  let payload;
  try {
    payload = buildPayload(eventRow);
  } catch (error) {
    stats.publishFailures += 1;
    throw error;
  }

  const runner = options.db && typeof options.db.query === 'function' ? options.db : db;
  try {
    await runner.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify(payload)]);
    stats.published += 1;
    return payload;
  } catch (error) {
    stats.publishFailures += 1;
    throw error;
  }
}

async function loadPersistedEvent(payload, options = {}) {
  if (payload.type === USER_ALERT_PAYLOAD_TYPE) {
    const model = options.userAlertEventModel || userAlertEvent;
    return model.getEventForUser(payload.eventId, payload.userId);
  }

  const model = options.gmgnClaimAlertEventModel || gmgnClaimAlertEvent;
  return model.getEventById(payload.eventId);
}

async function emitPersistedEvent(payload, options = {}) {
  const eventRow = await loadPersistedEvent(payload, options);
  if (!eventRow) {
    stats.skipped += 1;
    return { emitted: false, reason: 'event_not_found' };
  }

  const feed = options.backendAlertFeed || backendAlertFeed;
  const hub = options.socketHub || socketHub;
  const dashboardPayload = await feed.buildDashboardAlertEventFromEvent(eventRow);
  const emitted = hub.emitBackendAlertEvent(dashboardPayload, { userId: payload.userId ?? null });
  if (emitted) {
    stats.emitted += 1;
  } else {
    stats.skipped += 1;
  }

  return {
    emitted: Boolean(emitted),
    payload: dashboardPayload,
  };
}

function canPublishEvent(eventRow) {
  return eventRow?.userId != null || eventRow?.ruleKey === GMGN_CLAIM_SIGNAL_RULE_KEY;
}

async function handleNotification(message, options = {}) {
  if (message?.channel !== CHANNEL) {
    return null;
  }

  const payload = parsePayload(message.payload);
  if (!payload) {
    stats.skipped += 1;
    return null;
  }

  stats.received += 1;
  try {
    await emitPersistedEvent(payload, options);
    return payload;
  } catch (error) {
    stats.errors += 1;
    lastError = error?.message || String(error || 'Unknown realtime alert error');
    console.error('[BackendAlertRealtime] Failed to emit persisted alert event:', lastError);
    return payload;
  }
}

async function start(options = {}) {
  if (listenerClient) {
    return getStatus();
  }

  const pool = options.pool || db.pool;
  const client = await pool.connect();
  const onNotification = (message) => {
    void handleNotification(message, options);
  };
  const onError = (error) => {
    lastError = error?.message || String(error || 'Unknown listener error');
    listening = false;
    console.error('[BackendAlertRealtime] listener error:', lastError);
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
  console.log(`[BackendAlertRealtime] Listening on ${CHANNEL}`);
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
    lastError,
    ...stats,
  };
}

module.exports = {
  CHANNEL,
  GLOBAL_ALERT_PAYLOAD_TYPE,
  PAYLOAD_TYPE: USER_ALERT_PAYLOAD_TYPE,
  USER_ALERT_PAYLOAD_TYPE,
  buildPayload,
  canPublishEvent,
  emitPersistedEvent,
  getStatus,
  handleNotification,
  parsePayload,
  publishEventCreated,
  start,
  stop,
  __private: {
    getPayloadType,
    loadPersistedEvent,
    normalizePositiveInteger,
  },
};
