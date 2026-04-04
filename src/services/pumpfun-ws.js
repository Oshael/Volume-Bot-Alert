/**
 * PumpFun WebSocket Service
 * Maintains a single server-side WebSocket connection to PumpFun.
 * Distributes raw trade data and token creation events to all connected clients.
 *
 * Events emitted via onEvent callback:
 * - { type: 'newToken', data: {...} }        - new token created on PumpFun
 * - { type: 'trade', data: {...} }           - trade on a subscribed token
 * - { type: 'migrate', data: {...} }         - token migrated to DEX
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
let reconnectDelay = RECONNECT_DELAY;
let isRunning = false;
let subscribedTokens = new Set();
let eventCallback = null;
let stats = {
  connected: false,
  reconnects: 0,
  messagesReceived: 0,
  lastMessage: null,
  subscribedCount: 0,
};

function emit(type, data) {
  if (eventCallback) {
    eventCallback({ type, data });
  }
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

    // Subscribe to new token events
    safeSend({ method: 'subscribeNewToken' });
    safeSend({ method: 'subscribeMigration' });
    logTrace('pump_migrate_subscription_sent', {
      tokenAddress: '_global_',
      method: 'subscribeMigration',
    });

    // Re-subscribe to all tracked tokens
    for (const mint of subscribedTokens) {
      safeSend({ method: 'subscribeTokenTrade', keys: [mint] });
    }

    emit('status', { connected: true });
    startPing();
  });

  ws.on('message', (raw) => {
    stats.messagesReceived++;
    stats.lastMessage = Date.now();

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore non-JSON
    }

    if (msg.txType === 'create') {
      emit('newToken', msg);
      return;
    }

    if (msg.txType === 'buy' || msg.txType === 'sell') {
      emit('trade', msg);
      return;
    }

    if (msg.txType === 'migrate') {
      const mint = msg.mint;
      logTrace('pump_migrate_received', {
        tokenAddress: mint || null,
        txType: msg.txType || null,
        symbol: msg.symbol || null,
        name: msg.name || null,
        marketCapSol: Number.isFinite(Number(msg?.marketCapSol)) ? Number(msg.marketCapSol) : null,
        signature: msg.signature || null,
      });
      if (mint) {
        subscribedTokens.delete(mint);
        stats.subscribedCount = subscribedTokens.size;
        safeSend({ method: 'unsubscribeTokenTrade', keys: [mint] });
      }
      emit('migrate', msg);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[PumpFun] WebSocket closed: ${code} ${reason || ''}`);
    stats.connected = false;
    stopPing();
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

function safeSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(data));
    } catch (err) {
      console.error('[PumpFun] Send error:', err.message);
    }
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

function unsubscribeToken(mint) {
  if (subscribedTokens.has(mint)) {
    subscribedTokens.delete(mint);
    stats.subscribedCount = subscribedTokens.size;
    safeSend({ method: 'unsubscribeTokenTrade', keys: [mint] });
  }
}

function subscribeToken(mint) {
  if (!subscribedTokens.has(mint)) {
    subscribedTokens.add(mint);
    stats.subscribedCount = subscribedTokens.size;
    safeSend({ method: 'subscribeTokenTrade', keys: [mint] });
  }
}

function start(onEvent) {
  if (isRunning) return;
  isRunning = true;
  eventCallback = onEvent;
  console.log('[PumpFun] Starting WebSocket connection...');
  connect();
}

function stop() {
  isRunning = false;
  eventCallback = null;
  stopPing();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.removeAllListeners();
    ws.close();
    ws = null;
  }
  subscribedTokens.clear();
  stats.connected = false;
  stats.subscribedCount = 0;
  stats.messagesReceived = 0;
  stats.lastMessage = null;
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
};
