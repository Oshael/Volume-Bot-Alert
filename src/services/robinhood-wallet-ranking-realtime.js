const config = require('../../config');
const db = require('../models/db');
const { CHANNEL } = require('../models/robinhood-wallet-ranking-invalidation');
const { isRobinhoodUserVisible } = require('../utils/token-chain-availability');
const socketHub = require('./socket-hub');
const { createPostgresRealtimeListener } = require('./postgres-realtime-listener');
const { advanceGainersRevision } = require('./robinhood-radar-gainers-generation');

const SOURCES = new Set(['positions', 'transfers', 'swaps', 'prices', 'reorg']);
const COALESCE_MS = 25;
const RETRY_MS = 5000;
const MAX_VERSION = 9223372036854775807n;
const REVISIONS_SQL = `SELECT source, version::text AS version
  FROM robinhood_wallet_ranking_revisions`;

function parseRevision(payload) {
  if (payload?.chain !== 'robinhood' || !SOURCES.has(payload.source)
    || typeof payload.version !== 'string' || !/^[1-9][0-9]{0,18}$/.test(payload.version)) {
    return null;
  }
  const version = BigInt(payload.version);
  return version <= MAX_VERSION ? { source: payload.source, version } : null;
}

function createRobinhoodWalletRankingRealtime(deps = {}) {
  const database = deps.database || db;
  const emitSignal = deps.emitSignal || socketHub.emitWalletRankingInvalidation;
  const visible = deps.visible || (() => isRobinhoodUserVisible(config));
  const listenerFactory = deps.listenerFactory || createPostgresRealtimeListener;
  const logger = deps.logger || console;
  const now = deps.now || Date.now;
  const schedule = deps.setTimeoutFn || setTimeout;
  const cancel = deps.clearTimeoutFn || clearTimeout;
  const latest = new Map();
  const pending = new Map();
  const stats = {
    received: 0, invalid: 0, duplicates: 0, coalesced: 0,
    reconciled: 0, published: 0, publishedSources: 0,
    suppressed: 0, publishFailures: 0, reconciliationFailures: 0,
    lastPublishedAt: null, lastRelayMs: null, lastError: null,
  };
  let running = false;
  let flushTimer = null;
  let retryTimer = null;
  let reconciliation = null;

  function scheduleFlush() {
    if (!running || flushTimer || retryTimer || pending.size === 0) return;
    flushTimer = schedule(() => {
      flushTimer = null;
      flush();
    }, COALESCE_MS);
    flushTimer.unref?.();
  }

  function scheduleRetry() {
    if (!running || retryTimer) return;
    retryTimer = schedule(() => {
      retryTimer = null;
      if (pending.size) flush();
      void reconcile();
    }, RETRY_MS);
    retryTimer.unref?.();
  }

  function accept(revision, recovered = false) {
    if (!running || !revision) return false;
    const previous = latest.get(revision.source) || 0n;
    if (revision.version <= previous) {
      stats.duplicates += 1;
      return false;
    }
    if (pending.has(revision.source)) stats.coalesced += 1;
    latest.set(revision.source, revision.version);
    advanceGainersRevision(revision.source, revision.version);
    pending.set(revision.source, {
      version: revision.version.toString(), receivedAt: now(),
    });
    if (recovered) stats.reconciled += 1;
    scheduleFlush();
    return true;
  }

  function handleNotification(message) {
    if (message?.channel !== CHANNEL) return false;
    stats.received += 1;
    let revision;
    try {
      revision = parseRevision(JSON.parse(String(message.payload || '')));
    } catch (_) {
      revision = null;
    }
    if (!revision) {
      stats.invalid += 1;
      return false;
    }
    return accept(revision);
  }

  function flush() {
    if (!running || pending.size === 0) return false;
    if (flushTimer) cancel(flushTimer);
    flushTimer = null;
    if (!visible()) {
      stats.suppressed += pending.size;
      pending.clear();
      return false;
    }
    const values = [...pending];
    const publishedAt = new Date(now()).toISOString();
    const event = {
      type: 'wallet-ranking:invalidate', chain: 'robinhood', version: 1,
      revisions: Object.fromEntries(values.map(([source, value]) => [source, value.version])),
      publishedAt,
    };
    try {
      if (!emitSignal(event)) throw new Error('socket hub rejected ranking invalidation');
      for (const [source, value] of values) {
        if (pending.get(source) === value) pending.delete(source);
      }
      stats.published += 1;
      stats.publishedSources += values.length;
      stats.lastPublishedAt = publishedAt;
      stats.lastRelayMs = Math.max(0, now() - Math.min(...values.map(([, value]) => value.receivedAt)));
      stats.lastError = null;
      if (pending.size) scheduleFlush();
      return true;
    } catch (error) {
      stats.publishFailures += 1;
      stats.lastError = error.message;
      logger.error?.('[RobinhoodWalletRankingRealtime] publish failed:', error.message);
      scheduleRetry();
      return false;
    }
  }

  async function reconcile() {
    if (!running) return false;
    if (reconciliation) return reconciliation;
    reconciliation = (async () => {
      try {
        const result = typeof database.queryWithStatementTimeout === 'function'
          ? await database.queryWithStatementTimeout(REVISIONS_SQL, [], 5000)
          : await database.query(REVISIONS_SQL);
        for (const row of result.rows) {
          const revision = parseRevision({ ...row, chain: 'robinhood' });
          if (revision) accept(revision, true);
        }
        stats.lastError = null;
        return true;
      } catch (error) {
        stats.reconciliationFailures += 1;
        stats.lastError = error.message;
        logger.error?.('[RobinhoodWalletRankingRealtime] reconciliation failed:', error.message);
        scheduleRetry();
        return false;
      }
    })().finally(() => { reconciliation = null; });
    return reconciliation;
  }

  const listener = listenerFactory({
    channel: CHANNEL,
    label: 'RobinhoodWalletRankingRealtime',
    logger,
    onNotification: handleNotification,
    onConnected: ({ isReconnect }) => { if (isReconnect) void reconcile(); },
  });

  async function start(options = {}) {
    if (running) return getStatus();
    running = true;
    await listener.start({ pool: options.pool || deps.pool || db.pool });
    await reconcile();
    return getStatus();
  }

  async function stop() {
    running = false;
    if (flushTimer) cancel(flushTimer);
    if (retryTimer) cancel(retryTimer);
    flushTimer = null;
    retryTimer = null;
    pending.clear();
    await listener.stop();
  }

  function getStatus() {
    return {
      ...listener.getStatus(), running, pending: pending.size,
      revisions: Object.fromEntries([...latest].map(([source, value]) => [source, value.toString()])),
      ...stats,
    };
  }

  return { start, stop, getStatus, handleNotification, reconcile, flush };
}

module.exports = { CHANNEL, COALESCE_MS, createRobinhoodWalletRankingRealtime };
