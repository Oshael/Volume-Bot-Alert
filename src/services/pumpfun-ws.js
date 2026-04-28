/**
 * PumpFun WebSocket Service
 * Maintains a single server-side WebSocket connection to PumpFun.
 * Backend-only migration feed used to seed the token catalog.
 *
 * Events emitted via onEvent callback:
 * - { type: 'migrate', data: {...} }         - token migrated to DEX
 * - { type: 'create', data: {...} }          - token created on PumpFun
 * - { type: 'trade', data: {...} }           - subscribed token trade
 * - { type: 'status', data: { connected } }  - connection status change
 */

const WebSocket = require('ws');
const { logTrace } = require('../utils/pump-migrate-trace');

const PUMPFUN_WS_URL = 'wss://pumpportal.fun/api/data';
const RECONNECT_DELAY = 3000;    // 3s between reconnect attempts
const PING_INTERVAL = 30000;     // 30s keepalive ping
const MAX_RECONNECT_DELAY = 60000; // max 60s backoff

let ws = null;
let pingTimer = null;
let reconnectTimer = null;
let pruneTimer = null;
let reconnectDelay = RECONNECT_DELAY;
let isRunning = false;
let eventCallback = null;
let options = {
  preMigrationCaptureEnabled: false,
  preMigrationMaxTracked: 250,
  preMigrationTrackTtlMs: 2 * 60 * 60 * 1000,
};
const trackedTradeMints = new Map();
let stats = {
  connected: false,
  reconnects: 0,
  messagesReceived: 0,
  lastMessage: null,
  subscribedCount: 0,
  newTokenSubscribed: false,
  preMigrationCaptureEnabled: false,
};

function emit(type, data) {
  if (eventCallback) {
    eventCallback({ type, data });
  }
}

function sanitizeMint(rawMint) {
  if (typeof rawMint !== 'string') return null;
  const mint = rawMint.replace(/[^a-zA-Z0-9]/g, '');
  if (mint.length < 20 || mint.length > 64) return null;
  return mint;
}

function resolveOptions(input = {}) {
  return {
    preMigrationCaptureEnabled: input.enabled === true || input.preMigrationCaptureEnabled === true,
    preMigrationMaxTracked: Math.max(1, Math.min(
      Number(input.maxTracked ?? input.preMigrationMaxTracked) || 250,
      2000
    )),
    preMigrationTrackTtlMs: Math.max(
      60000,
      Number(input.trackTtlMs ?? input.preMigrationTrackTtlMs) || (2 * 60 * 60 * 1000)
    ),
  };
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    ws = new WebSocket(PUMPFUN_WS_URL);
  } catch (err) {
    console.error('[PumpFun] WebSocket creation error:', err.message);
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    console.log('[PumpFun] WebSocket connected');
    stats.connected = true;
    reconnectDelay = RECONNECT_DELAY; // reset backoff

    // Only migrations are needed in backend-only mode. New-token/trade streams
    // are optional and bounded because they are used only for pre-migration buckets.
    safeSend({ method: 'subscribeMigration' });
    logTrace('pump_migrate_subscription_sent', {
      tokenAddress: '_global_',
      method: 'subscribeMigration',
    });
    if (options.preMigrationCaptureEnabled) {
      safeSend({ method: 'subscribeNewToken' });
      stats.newTokenSubscribed = true;
      stats.preMigrationCaptureEnabled = true;
    }

    emit('status', { connected: true });
    startPing();
    startPruneTimer();
  });

  ws.on('message', handleMessage);

  ws.on('close', (code, reason) => {
    console.log(`[PumpFun] WebSocket closed: ${code} ${reason || ''}`);
    stats.connected = false;
    stats.subscribedCount = 0;
    stats.newTokenSubscribed = false;
    trackedTradeMints.clear();
    stopPing();
    stopPruneTimer();
    emit('status', { connected: false });

    if (isRunning) {
      scheduleReconnect();
    }
  });

  ws.on('error', (err) => {
    console.error('[PumpFun] WebSocket error:', err.message);
    // close event will handle reconnect
  });
}

function parseMessage(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

function handleMigrateMessage(msg, mint) {
  logTrace('pump_migrate_received', {
    tokenAddress: mint || null,
    txType: msg.txType || null,
    symbol: msg.symbol || null,
    name: msg.name || null,
    marketCapSol: Number.isFinite(Number(msg?.marketCapSol)) ? Number(msg.marketCapSol) : null,
    signature: msg.signature || null,
  });
  emit('migrate', msg);
  if (mint) {
    unsubscribeToken(mint);
  }
}

function handleCreateMessage(msg, mint) {
  if (!options.preMigrationCaptureEnabled) return;
  emit('create', msg);
  if (mint) {
    subscribeToken(mint);
  }
}

function handleTradeMessage(msg, mint) {
  if (!options.preMigrationCaptureEnabled) return;
  emit('trade', msg);
  if (mint && trackedTradeMints.has(mint)) {
    trackedTradeMints.set(mint, Date.now());
  }
}

function handleMessage(raw) {
  stats.messagesReceived++;
  stats.lastMessage = Date.now();

  const msg = parseMessage(raw);
  if (!msg) return;

  const mint = sanitizeMint(msg.mint);
  if (msg.txType === 'migrate') {
    handleMigrateMessage(msg, mint);
  } else if (msg.txType === 'create') {
    handleCreateMessage(msg, mint);
  } else if (msg.txType === 'buy' || msg.txType === 'sell') {
    handleTradeMessage(msg, mint);
  }
}

function safeSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(data));
    } catch (err) {
      console.error('[PumpFun] Send error:', err.message);
    }
  }
}

function pruneTrackedTradeMints() {
  if (!options.preMigrationCaptureEnabled || !trackedTradeMints.size) return;

  const now = Date.now();
  const cutoff = now - options.preMigrationTrackTtlMs;
  for (const [mint, lastSeenAt] of trackedTradeMints.entries()) {
    if (lastSeenAt < cutoff) {
      unsubscribeToken(mint);
    }
  }
}

function startPruneTimer() {
  stopPruneTimer();
  if (!options.preMigrationCaptureEnabled) return;
  pruneTimer = setInterval(pruneTrackedTradeMints, 60000);
}

function stopPruneTimer() {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, PING_INTERVAL);
}

function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  stats.reconnects++;
  console.log(`[PumpFun] Reconnecting in ${reconnectDelay / 1000}s... (attempt ${stats.reconnects})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY);
}

function trimTrackedTradeMints() {
  const overflow = trackedTradeMints.size - options.preMigrationMaxTracked;
  if (overflow <= 0) return;

  const oldest = Array.from(trackedTradeMints.entries())
    .sort((a, b) => a[1] - b[1])
    .slice(0, overflow);
  for (const [mint] of oldest) {
    unsubscribeToken(mint);
  }
}

function unsubscribeToken(rawMint) {
  const mint = sanitizeMint(rawMint);
  if (!mint || !trackedTradeMints.has(mint)) return false;
  safeSend({ method: 'unsubscribeTokenTrade', keys: [mint] });
  trackedTradeMints.delete(mint);
  stats.subscribedCount = trackedTradeMints.size;
  return true;
}

function subscribeToken(rawMint) {
  const mint = sanitizeMint(rawMint);
  if (!mint || !options.preMigrationCaptureEnabled) return false;
  if (trackedTradeMints.has(mint)) {
    trackedTradeMints.set(mint, Date.now());
    return true;
  }

  safeSend({ method: 'subscribeTokenTrade', keys: [mint] });
  trackedTradeMints.set(mint, Date.now());
  trimTrackedTradeMints();
  stats.subscribedCount = trackedTradeMints.size;
  return true;
}

function start(onEvent, startOptions = {}) {
  if (isRunning) return;
  isRunning = true;
  eventCallback = onEvent;
  options = resolveOptions(startOptions);
  stats.preMigrationCaptureEnabled = options.preMigrationCaptureEnabled;
  console.log('[PumpFun] Starting WebSocket connection...');
  connect();
}

function stop() {
  isRunning = false;
  eventCallback = null;
  stopPing();
  stopPruneTimer();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.removeAllListeners();
    ws.close();
    ws = null;
  }
  stats.connected = false;
  stats.subscribedCount = 0;
  stats.newTokenSubscribed = false;
  stats.preMigrationCaptureEnabled = false;
  stats.messagesReceived = 0;
  stats.lastMessage = null;
  trackedTradeMints.clear();
}

function getStatus() {
  return { ...stats };
}

module.exports = {
  start,
  stop,
  getStatus,
  subscribeToken,
  unsubscribeToken,
  __private: {
    resolveOptions,
    sanitizeMint,
  },
};
