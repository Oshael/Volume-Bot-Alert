const db = require('../models/db');
const socketHub = require('./socket-hub');
const { createPostgresRealtimeListener } = require('./postgres-realtime-listener');
const { createRealtimeLatencyWindow } = require('./realtime-latency-window');
const {
  buildMarketTradeFinalityEvent, normalizeMarketTradeFinalityEvent,
} = require('./market-trade-finality-event');

const CHANNEL = 'market_trade_created';
const FINALITY_CHANNEL = 'market_trade_finality_v2';
const MAX_PAYLOAD_BYTES = 7800;

function buildMarketTradeUpdate(row) {
  return {
    type: 'market:trade',
    chain: 'robinhood',
    address: row.tokenAddress,
    transactionHash: row.transactionHash,
    actionIndex: Number(row.actionIndex),
    blockNumber: Number(row.blockNumber),
    blockHash: row.blockHash,
    blockTime: row.blockTime,
    observedAt: row.observedAt || row.latency?.receiptsAvailableAt || row.blockTime,
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
  const stats = {
    published: 0, publishFailures: 0, received: 0,
    finalityPublished: 0, finalityPublishFailures: 0, finalityReceived: 0,
  };

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

  async function publishFinalityRows(rows = []) {
    const validationTime = new Date(now()).toISOString();
    const notifications = rows.map((row) => normalizeMarketTradeFinalityEvent({
      ...row,
      chain: 'robinhood', address: row?.address || row?.tokenAddress,
      amountUsd: row?.amountUsd ?? row?.volumeUsd,
      mcUsd: row?.mcUsd ?? row?.fdvUsd,
      publishedAt: validationTime,
    })).map((event) => {
      if (!event) throw new Error('market trade finality payload is invalid');
      const transport = { ...event };
      delete transport.publishedAt;
      const serialized = JSON.stringify(transport);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
        throw new Error('market trade finality payload exceeds notification limit');
      }
      return serialized;
    });
    if (!notifications.length) return false;
    try {
      await database.query(
        'SELECT pg_notify($1, notification) FROM unnest($2::text[]) AS batch(notification)',
        [FINALITY_CHANNEL, notifications]
      );
      stats.finalityPublished += notifications.length;
      return true;
    } catch (error) {
      stats.finalityPublishFailures += notifications.length;
      logger.error('[MarketTradeRealtime] finality publish failed:', error.message);
      throw error;
    }
  }

  function handleNotification(message) {
    if (message?.channel !== CHANNEL) return null;
    let event;
    try {
      const payload = JSON.parse(String(message.payload || '{}'));
      const publishedAt = new Date(now()).toISOString();
      event = normalize({
        ...payload,
        publishedAt,
        latency: {
          ...(payload.latency && typeof payload.latency === 'object' ? payload.latency : {}),
          publishedAt,
        },
      });
    } catch (_) {
      return null;
    }
    if (!event) return null;
    stats.received += 1;
    latency.record(event.latency, event.latency?.publishedAt);
    hub.emitMarketTradeUpdate(event);
    const finalityEvent = buildMarketTradeFinalityEvent(event, 'finalized');
    if (finalityEvent) hub.emitMarketTradeFinalityUpdate?.(finalityEvent);
    return event;
  }

  function handleFinalityNotification(message) {
    if (message?.channel !== FINALITY_CHANNEL) return null;
    let event;
    try {
      const payload = JSON.parse(String(message.payload || '{}'));
      const publishedAt = new Date(now()).toISOString();
      event = normalizeMarketTradeFinalityEvent({
        ...payload, publishedAt,
        latency: { ...(payload.latency || {}), publishedAt },
      });
    } catch (_) {
      return null;
    }
    if (!event) return null;
    stats.finalityReceived += 1;
    hub.emitMarketTradeCanaryUpdate?.(event);
    return event;
  }

  const listener = createPostgresRealtimeListener({
    channel: CHANNEL,
    label: 'MarketTradeRealtime',
    logger,
    pool: deps.pool || db.pool,
    onNotification: handleNotification,
  });
  const finalityListener = createPostgresRealtimeListener({
    channel: FINALITY_CHANNEL,
    label: 'MarketTradeFinalityRealtime',
    logger,
    pool: deps.pool || db.pool,
    onNotification: handleFinalityNotification,
  });

  return {
    publishRows, publishFinalityRows,
    handleNotification,
    handleFinalityNotification,
    start: async () => Promise.all([listener.start(), finalityListener.start()]),
    stop: async () => Promise.all([listener.stop(), finalityListener.stop()]),
    getStatus: () => ({
      ...listener.getStatus(), finalityListener: finalityListener.getStatus(),
      ...stats, latency: latency.snapshot(),
    }),
  };
}

const realtime = createMarketTradeRealtime();

module.exports = {
  CHANNEL, FINALITY_CHANNEL, buildMarketTradeUpdate, createMarketTradeRealtime, ...realtime,
};
