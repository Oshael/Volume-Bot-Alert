const db = require('../models/db');
const workerLease = require('../models/worker-lease');
const {
  NOTIFY_CHANNEL: CAPTURE_NOTIFY_CHANNEL,
} = require('../models/robinhood-chain-capture-journal');
const { createPostgresRealtimeListener } = require('./postgres-realtime-listener');
const {
  createWorkspaceChainReadinessSignature,
  getWorkspaceChainReadiness,
} = require('./workspace-chain-readiness');
const PROTOCOL_VERSION = 1;
const COALESCE_MS = 50;
function createWorkspaceChainReadinessRealtime(deps = {}) {
  const provider = deps.provider || getWorkspaceChainReadiness;
  const emitSignal = deps.emitSignal || (() => false);
  const listenerFactory = deps.listenerFactory || createPostgresRealtimeListener;
  const logger = deps.logger || console;
  const setTimer = deps.setTimeoutFn || setTimeout;
  const clearTimer = deps.clearTimeoutFn || clearTimeout;
  let lastSignature = null;
  let refreshPromise = null;
  let refreshRequested = false;
  let timer = null;
  let running = false;
  async function refresh(options = {}) {
    refreshRequested = true;
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      let emitted = false, suppressEmit = options.emit === false;
      while (refreshRequested && running) {
        refreshRequested = false;
        provider.invalidate?.();
        const snapshot = await provider({ force: true });
        const signature = createWorkspaceChainReadinessSignature(snapshot);
        const changed = signature !== lastSignature;
        lastSignature = signature;
        if (changed && !suppressEmit) {
          emitted = emitSignal({
            type: 'workspace:readiness',
            version: PROTOCOL_VERSION,
            signature,
            checkedAt: snapshot.robinhood?.checkedAt || snapshot.solana?.checkedAt || null,
          }) || emitted;
        }
        suppressEmit = false;
      }
      return emitted;
    })().catch((error) => {
      logger.error?.('[WorkspaceChainReadinessRealtime] refresh failed:', error.message);
      return false;
    }).finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }
  function scheduleRefresh() {
    if (!running || timer) return;
    timer = setTimer(() => {
      timer = null;
      void refresh();
    }, COALESCE_MS);
    timer.unref?.();
  }
  const channels = [workerLease.READINESS_NOTIFY_CHANNEL, CAPTURE_NOTIFY_CHANNEL];
  const listeners = channels.map((channel) => listenerFactory({
    channel,
    label: 'WorkspaceChainReadinessRealtime',
    logger,
    onNotification: scheduleRefresh,
    onConnected: ({ isReconnect }) => {
      if (isReconnect) scheduleRefresh();
    },
  }));
  async function start(options = {}) {
    if (running) return getStatus();
    running = true;
    await Promise.all(listeners.map((listener) => listener.start({
      pool: options.pool || deps.pool || db.pool,
    })));
    await refresh({ emit: false });
    return getStatus();
  }
  async function stop() {
    running = false;
    refreshRequested = false;
    if (timer) clearTimer(timer);
    timer = null;
    await Promise.all(listeners.map((listener) => listener.stop()));
  }
  function getStatus() {
    return {
      running,
      signature: lastSignature,
      listeners: listeners.map((listener) => listener.getStatus()),
    };
  }
  return { getStatus, start, stop, __private: { refresh, scheduleRefresh } };
}
module.exports = { COALESCE_MS, PROTOCOL_VERSION, createWorkspaceChainReadinessRealtime };
