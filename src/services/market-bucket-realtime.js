const db = require('../models/db');
const socketHub = require('./socket-hub');

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
  let listener = null;
  let listening = false;
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

  async function start(options = {}) {
    if (listener) return getStatus();
    const client = await (options.pool || db.pool).connect();
    const onNotification = (message) => handleNotification(message);
    const onError = (error) => {
      listening = false;
      logger.error('[MarketBucketRealtime] listener error:', error.message);
    };
    const onEnd = () => {
      listening = false;
      listener = null;
    };
    client.on('notification', onNotification);
    client.on('error', onError);
    client.on('end', onEnd);
    try {
      await client.query(`LISTEN ${CHANNEL}`);
    } catch (error) {
      client.off?.('notification', onNotification);
      client.off?.('error', onError);
      client.off?.('end', onEnd);
      client.release?.();
      throw error;
    }
    listener = { client, onNotification, onError, onEnd };
    listening = true;
    logger.log(`[MarketBucketRealtime] Listening on ${CHANNEL}`);
    return getStatus();
  }

  async function stop() {
    const current = listener;
    listener = null;
    listening = false;
    if (flushTimer) cancel(flushTimer);
    flushTimer = null;
    if (!current) return;
    current.client.off?.('notification', current.onNotification);
    current.client.off?.('error', current.onError);
    current.client.off?.('end', current.onEnd);
    try {
      await current.client.query(`UNLISTEN ${CHANNEL}`);
    } catch (_) {}
    current.client.release?.();
  }

  function getStatus() {
    return { channel: CHANNEL, listening, pending: pending.size, ...stats };
  }

  return { enqueue, flush, getStatus, handleNotification, start, stop };
}

const realtime = createMarketBucketRealtime();

module.exports = { CHANNEL, createMarketBucketRealtime, ...realtime };
