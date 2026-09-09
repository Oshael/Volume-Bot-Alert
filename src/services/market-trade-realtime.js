const db = require('../models/db');
const socketHub = require('./socket-hub');
const { createPostgresRealtimeListener } = require('./postgres-realtime-listener');
const { createRealtimeLatencyWindow } = require('./realtime-latency-window');

const CHANNEL = 'market_trade_created';
const MAX_PAYLOAD_BYTES = 7800;

function buildMarketTradeUpdate(row) {
  return {
    type: 'market:trade',
    chain: 'robinhood',
    address: row.tokenAddress,
    transactionHash: row.transactionHash,
    actionIndex: Number(row.actionIndex),
    blockNumber: Number(row.blockNumber),
    blockTime: row.blockTime,
    side: row.side,
    walletAddress: row.walletAddress,
    amountUsd: row.volumeUsd == null ? null : Number(row.volumeUsd),
    priceUsd: row.priceUsd == null ? null : Number(row.priceUsd),
    mcUsd: row.fdvUsd == null ? null : Number(row.fdvUsd),
    latency: row.latency && typeof row.latency === 'object' ? row.latency : undefined,
  };
}

function createMarketTradeRealtime(deps = {}) {
  const database = deps.database || db;
  const hub = deps.socketHub || socketHub;
  const normalize = deps.normalize || socketHub.__private.normalizeMarketTradeUpdate;
  const logger = deps.logger || console;
  const now = deps.now || Date.now;
  const latency = deps.latency || createRealtimeLatencyWindow({ now });
  const stats = { published: 0, publishFailures: 0, received: 0 };

  async function publishRows(rows = []) {
    const projectionCommittedAt = new Date(now()).toISOString();
    const notifications = rows
      .map((row) => buildMarketTradeUpdate({
        ...row,
        latency: {
          ...(row.latency && typeof row.latency === 'object' ? row.latency : {}),
          projectionCommittedAt,
        },
      }))
      .map(normalize)
      .filter(Boolean)
      .map((event) => JSON.stringify(event))
      .filter((serialized) => Buffer.byteLength(serialized, 'utf8') <= MAX_PAYLOAD_BYTES);
    if (notifications.length === 0) return false;
    try {
      await database.query(
        'SELECT pg_notify($1, notification) FROM unnest($2::text[]) AS batch(notification)',
        [CHANNEL, notifications]
      );
      stats.published += notifications.length;
      return true;
    } catch (error) {
      stats.publishFailures += notifications.length;
      logger.error('[MarketTradeRealtime] publish failed:', error.message);
      throw error;
    }
  }

  function handleNotification(message) {
    if (message?.channel !== CHANNEL) return null;
    let event;
    try {
      const payload = JSON.parse(String(message.payload || '{}'));
      event = normalize({
        ...payload,
        latency: {
          ...(payload.latency && typeof payload.latency === 'object' ? payload.latency : {}),
          publishedAt: new Date(now()).toISOString(),
        },
      });
    } catch (_) {
      return null;
    }
    if (!event) return null;
    stats.received += 1;
    latency.record(event.latency, event.latency?.publishedAt);
    hub.emitMarketTradeUpdate(event);
    return event;
  }

  const listener = createPostgresRealtimeListener({
    channel: CHANNEL,
    label: 'MarketTradeRealtime',
    logger,
    pool: deps.pool || db.pool,
    onNotification: handleNotification,
  });

  return {
    publishRows,
    handleNotification,
    start: listener.start,
    stop: listener.stop,
    getStatus: () => ({ ...listener.getStatus(), ...stats, latency: latency.snapshot() }),
  };
}

const realtime = createMarketTradeRealtime();

module.exports = {
  CHANNEL, buildMarketTradeUpdate, createMarketTradeRealtime, ...realtime,
};
