const db = require('../models/db');
const socketHub = require('./socket-hub');
const { createPostgresRealtimeListener } = require('./postgres-realtime-listener');
const {
  normalizeRobinhoodHolderRealtimeEvent,
} = require('./robinhood-holder-count-event');

const CHANNEL = 'robinhood_holder_count_updated';
const MAX_NOTIFY_BATCH = 500;
const MAX_PAYLOAD_BYTES = 7800;

function createRobinhoodHolderCountRealtime(deps = {}) {
  const database = deps.database || db;
  const hub = deps.socketHub || socketHub;
  const logger = deps.logger || console;
  const stats = { published: 0, publishFailures: 0, received: 0 };

  async function publishUpdates(values = []) {
    const byToken = new Map();
    for (const value of values) {
      const event = normalizeRobinhoodHolderRealtimeEvent(value);
      if (!event) continue;
      const serialized = JSON.stringify(event);
      if (Buffer.byteLength(serialized, 'utf8') <= MAX_PAYLOAD_BYTES) {
        byToken.set(event.address, serialized);
      }
    }
    const notifications = [...byToken.values()];
    try {
      for (let offset = 0; offset < notifications.length; offset += MAX_NOTIFY_BATCH) {
        const batch = notifications.slice(offset, offset + MAX_NOTIFY_BATCH);
        await database.query(
          'SELECT pg_notify($1, notification) FROM unnest($2::text[]) AS batch(notification)',
          [CHANNEL, batch]
        );
        stats.published += batch.length;
      }
      return notifications.length;
    } catch (error) {
      stats.publishFailures += notifications.length;
      logger.error('[RobinhoodHolderCountRealtime] publish failed:', error.message);
      throw error;
    }
  }

  function handleNotification(message) {
    if (message?.channel !== CHANNEL) return null;
    let event;
    try {
      event = normalizeRobinhoodHolderRealtimeEvent(JSON.parse(String(message.payload || '{}')));
    } catch (_) {
      return null;
    }
    if (!event) return null;
    stats.received += 1;
    hub.emitHolderUpdate(event);
    return event;
  }

  const listener = createPostgresRealtimeListener({
    channel: CHANNEL,
    label: 'RobinhoodHolderCountRealtime',
    logger,
    pool: deps.pool || db.pool,
    onNotification: handleNotification,
  });

  return {
    publishUpdates,
    handleNotification,
    start: listener.start,
    stop: listener.stop,
    getStatus: () => ({ ...listener.getStatus(), ...stats }),
  };
}

const realtime = createRobinhoodHolderCountRealtime();

module.exports = {
  CHANNEL, createRobinhoodHolderCountRealtime, ...realtime,
};
