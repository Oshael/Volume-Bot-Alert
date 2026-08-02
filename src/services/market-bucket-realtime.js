const db = require('../models/db');
const socketHub = require('./socket-hub');
const { createPostgresRealtimeListener } = require('./postgres-realtime-listener');

const CHANNEL = 'market_bucket_updated';
const MAX_BATCH_SIZE = 100;
const MAX_PAYLOAD_BYTES = 7800;
const FLUSH_DELAY_MS = 25;

function createMarketBucketRealtime(deps = {}) {
  const database = deps.database || db;
  const hub = deps.socketHub || socketHub;
  const normalize = deps.normalize || socketHub.__private.normalizeMarketBucketUpdate;
  const schedule = deps.schedule || setTimeout;
  const cancel = deps.cancel || clearTimeout;
  const logger = deps.logger || console;
  const pending = new Map();
  let flushTimer = null;
  let flushing = false;
  const stats = { queued: 0, coalesced: 0, published: 0, publishFailures: 0, received: 0 };

  function prepare(payload) {
    const event = normalize(payload);
    if (!event) return null;
    const serialized = JSON.stringify(event);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) return null;
    return { key: `${event.chain}:${event.address}`, serialized };
  }

  function scheduleFlush(delay = FLUSH_DELAY_MS) {
    if (flushTimer || flushing || pending.size === 0) return;
    flushTimer = schedule(() => {
      flushTimer = null;
      void flush();
    }, delay);
  }

  function enqueue(payload) {
    const prepared = prepare(payload);
    if (!prepared) return false;
    if (pending.has(prepared.key)) stats.coalesced += 1;
    pending.set(prepared.key, prepared.serialized);
    stats.queued += 1;
    scheduleFlush();
    return true;
  }

  async function flush() {
    if (flushing || pending.size === 0) return false;
    if (flushTimer) {
      cancel(flushTimer);
      flushTimer = null;
    }
    const batch = [...pending.entries()].slice(0, MAX_BATCH_SIZE);
    batch.forEach(([key]) => pending.delete(key));
    flushing = true;
    let retryDelay = FLUSH_DELAY_MS;
    try {
      await database.query(
        'SELECT pg_notify($1, notification) FROM unnest($2::text[]) AS batch(notification)',
        [CHANNEL, batch.map(([, serialized]) => serialized)]
      );
      stats.published += batch.length;
      return true;
    } catch (error) {
      retryDelay = 250;
      stats.publishFailures += batch.length;
      batch.forEach(([key, serialized]) => {
        if (!pending.has(key)) pending.set(key, serialized);
      });
      logger.error('[MarketBucketRealtime] publish failed:', error.message);
      return false;
    } finally {
      flushing = false;
      scheduleFlush(retryDelay);
    }
  }

  function handleNotification(message) {
    if (message?.channel !== CHANNEL) return null;
    let event;
    try {
      event = normalize(JSON.parse(String(message.payload || '{}')));
    } catch (_) {
      return null;
    }
    if (!event) return null;
    stats.received += 1;
    hub.emitMarketBucketUpdate(event);
    return event;
  }

  const listenerTransport = createPostgresRealtimeListener({
    channel: CHANNEL,
    label: 'MarketBucketRealtime',
    logger,
    pool: deps.pool || db.pool,
    onNotification: handleNotification,
  });

  async function start(options = {}) {
    await listenerTransport.start(options);
    return getStatus();
  }

  async function stop() {
    if (flushTimer) cancel(flushTimer);
    flushTimer = null;
    await listenerTransport.stop();
  }

  function getStatus() {
    return { ...listenerTransport.getStatus(), pending: pending.size, ...stats };
  }

  return { enqueue, flush, getStatus, handleNotification, start, stop };
}

const realtime = createMarketBucketRealtime();

module.exports = { CHANNEL, createMarketBucketRealtime, ...realtime };
