'use strict';
const config = require('../../config');
const db = require('../models/db');
const socketHub = require('./socket-hub');
const { createPostgresRealtimeListener } = require('./postgres-realtime-listener');
const { createRealtimeLatencyWindow } = require('./realtime-latency-window');
const {
  normalizeRobinhoodLiquidityRealtimeEvent,
} = require('./robinhood-liquidity-realtime-event');
const {
  createRobinhoodLiquidityRealtimeOutboxRepository,
} = require('../models/robinhood-liquidity-realtime-outbox');
const CHANNEL = 'market_liquidity_updated';
const MAX_PAYLOAD_BYTES = 7800;
const POINTER_TYPE = 'market:liquidity:refresh';
function normalizePointer(payload) {
  const address = String(payload?.address || '').trim().toLowerCase();
  const committedAtMs = Date.parse(String(payload?.liquidityProjectionCommittedAt || ''));
  if (payload?.type !== POINTER_TYPE || payload?.chain !== 'robinhood'
    || !/^0x[0-9a-f]{40}$/.test(address) || !Number.isFinite(committedAtMs)) return null;
  return { type: POINTER_TYPE, chain: 'robinhood', address,
    liquidityProjectionCommittedAt: new Date(committedAtMs).toISOString() };
}
function createMarketLiquidityRealtime(deps = {}) {
  const database = deps.database || db;
  const hub = deps.socketHub || socketHub;
  const logger = deps.logger || console;
  const now = deps.now || Date.now;
  const audienceEnabled = deps.audienceEnabled === true;
  const latency = deps.latency || createRealtimeLatencyWindow({ now });
  const projectionRepository = deps.projectionRepository
    || createRobinhoodLiquidityRealtimeOutboxRepository({ database });
  const stats = { audienceEnabled, published: 0, publishFailures: 0, notifications: 0,
    received: 0, hydrationFailures: 0 };
  const pendingPointers = new Map();
  let hydrationPromise = null;
  async function publish(payload) {
    const event = normalizeRobinhoodLiquidityRealtimeEvent(payload);
    const serialized = event && JSON.stringify({
      type: POINTER_TYPE, chain: event.chain, address: event.address,
      liquidityProjectionCommittedAt: event.liquidityProjectionCommittedAt,
    });
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
  function emitEvent(payload) {
    const event = normalizeRobinhoodLiquidityRealtimeEvent({
      ...payload, latency: {
        ...(payload.latency && typeof payload.latency === 'object' ? payload.latency : {}),
        publishedAt: new Date(now()).toISOString(),
      },
    });
    if (!event) return null;
    stats.received += 1;
    latency.record(event.latency, event.latency?.publishedAt);
    hub.emitMarketLiquidityUpdate(event);
    return event;
  }
  async function drainPointers() {
    while (pendingPointers.size > 0) {
      const pointers = [...pendingPointers.values()];
      pendingPointers.clear();
      for (const pointer of pointers) {
        try {
          const payload = await projectionRepository.readProjection(pointer);
          if (!emitEvent(payload)) throw new Error('invalid durable market liquidity projection');
        } catch (error) {
          stats.hydrationFailures += 1;
          logger.error?.('[MarketLiquidityRealtime] hydration failed:', error.message);
        }
      }
    }
  }
  function queuePointer(pointer) {
    const current = pendingPointers.get(pointer.address);
    if (!current || pointer.liquidityProjectionCommittedAt > current.liquidityProjectionCommittedAt)
      pendingPointers.set(pointer.address, pointer);
    if (!hydrationPromise) hydrationPromise = Promise.resolve().then(drainPointers)
      .finally(() => { hydrationPromise = null; });
    return hydrationPromise;
  }
  function handleNotification(message) {
    if (!audienceEnabled || message?.channel !== CHANNEL) return null;
    let payload;
    try {
      payload = JSON.parse(String(message.payload || '{}'));
    } catch (_) { return null; }
    stats.notifications += 1;
    const pointer = normalizePointer(payload);
    return pointer ? queuePointer(pointer) : emitEvent(payload);
  }
  const listener = createPostgresRealtimeListener({
    channel: CHANNEL, label: 'MarketLiquidityRealtime', logger,
    pool: deps.pool || db.pool, onNotification: (message) => { void handleNotification(message); },
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
module.exports = { CHANNEL, MAX_PAYLOAD_BYTES, POINTER_TYPE, createMarketLiquidityRealtime, ...realtime };
