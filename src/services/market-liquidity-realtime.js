'use strict';
const config = require('../../config');
const db = require('../models/db');
const socketHub = require('./socket-hub');
const { createPostgresRealtimeListener } = require('./postgres-realtime-listener');
const { createRealtimeLatencyWindow } = require('./realtime-latency-window');
const {
  normalizeRobinhoodLiquidityRealtimeEvent,
} = require('./robinhood-liquidity-realtime-event');
const CHANNEL = 'market_liquidity_updated';
const MAX_PAYLOAD_BYTES = 7800;
function createMarketLiquidityRealtime(deps = {}) {
  const database = deps.database || db;
  const hub = deps.socketHub || socketHub;
  const logger = deps.logger || console;
  const now = deps.now || Date.now;
  const audienceEnabled = deps.audienceEnabled === true;
  const latency = deps.latency || createRealtimeLatencyWindow({ now });
  const stats = { audienceEnabled, published: 0, publishFailures: 0, received: 0 };
  async function publish(payload) {
    const event = normalizeRobinhoodLiquidityRealtimeEvent(payload);
    const serialized = event && JSON.stringify(event);
    if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES)
      throw new Error('invalid or oversized market liquidity event');
    try {
      await database.query('SELECT pg_notify($1, $2)', [CHANNEL, serialized]);
      stats.published += 1;
      return true;
    } catch (error) {
      stats.publishFailures += 1;
      logger.error?.('[MarketLiquidityRealtime] publish failed:', error.message);
      throw error;
    }
  }
  function handleNotification(message) {
    if (!audienceEnabled || message?.channel !== CHANNEL) return null;
    let event;
    try {
      const payload = JSON.parse(String(message.payload || '{}'));
      event = normalizeRobinhoodLiquidityRealtimeEvent({
        ...payload, latency: {
          ...(payload.latency && typeof payload.latency === 'object' ? payload.latency : {}),
          publishedAt: new Date(now()).toISOString(),
        },
      });
    } catch (_) { return null; }
    if (!event) return null;
    stats.received += 1;
    latency.record(event.latency, event.latency?.publishedAt);
    hub.emitMarketLiquidityUpdate(event);
    return event;
  }
  const listener = createPostgresRealtimeListener({
    channel: CHANNEL, label: 'MarketLiquidityRealtime', logger,
    pool: deps.pool || db.pool, onNotification: handleNotification,
  });
  async function start(options) {
    if (audienceEnabled) await listener.start(options);
    return getStatus();
  }
  async function stop() { await listener.stop(); }
  function getStatus() {
    return { ...listener.getStatus(), ...stats, latency: latency.snapshot() };
  }
  return { getStatus, handleNotification, publish, start, stop };
}
const realtime = createMarketLiquidityRealtime({
  audienceEnabled: config.robinhoodCanonicalLiquidityWorker.realtimeAudienceEnabled,
});
module.exports = { CHANNEL, createMarketLiquidityRealtime, ...realtime };
