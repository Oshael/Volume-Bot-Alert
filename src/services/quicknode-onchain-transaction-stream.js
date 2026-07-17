const WebSocket = require('ws');

const {
  buildTransactionSubscribeParams,
  createTrafficStats,
  getRawByteLength,
  summarizeNotification,
  wasProgramInvoked,
} = require('../utils/quicknode-transaction-probe');

const DEFAULT_RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

function createProgramStats(program) {
  return {
    program: program.label,
    seen: 0,
    matches: 0,
    skippedMentionOnly: 0,
    traffic: createTrafficStats(),
  };
}

function createOnchainTransactionStream(options = {}) {
  const programs = Array.isArray(options.programs) ? options.programs : [];
  const wsFactory = options.wsFactory || ((url) => new WebSocket(url));
  const schedule = options.schedule || setTimeout;
  const cancelSchedule = options.cancelSchedule || clearTimeout;
  const now = options.now || Date.now;
  const onSummary = options.onSummary || (() => {});
  const onStatus = options.onStatus || (() => {});
  const onError = options.onError || (() => {});
  const statsByProgram = new Map(programs.map((program) => [program.label, createProgramStats(program)]));
  const requestToProgram = new Map();
  const subscriptionToProgram = new Map();
  let ws = null;
  let stopped = false;
  let reconnectTimer = null;
  let reconnectDelayMs = Number(options.reconnectDelayMs) || DEFAULT_RECONNECT_DELAY_MS;

  function emitStatus(status, extra = {}) {
    onStatus({ status, ...extra });
  }

  function sendSubscriptions() {
    requestToProgram.clear();
    subscriptionToProgram.clear();
    programs.forEach((program, index) => {
      const id = index + 1;
      requestToProgram.set(id, program);
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'transactionSubscribe',
        params: buildTransactionSubscribeParams(program.address, options),
      }));
    });
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delayMs = reconnectDelayMs;
    emitStatus('reconnecting', { delayMs });
    reconnectTimer = schedule(() => {
      reconnectTimer = null;
      connect();
    }, delayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
  }

  function recordTraffic(program, raw, bucket) {
    const stats = statsByProgram.get(program.label);
    const bytes = getRawByteLength(raw);
    stats.traffic.messages += 1;
    stats.traffic.receivedBytes += bytes;
    stats.traffic[bucket] += bytes;
    return stats;
  }

  function handleSubscriptionResponse(message, raw) {
    const program = requestToProgram.get(Number(message.id));
    if (!program) return false;
    const stats = recordTraffic(program, raw, 'subscriptionBytes');
    if (message.error) {
      onError(new Error(`${program.label} subscribe failed: ${message.error.message}`));
      return true;
    }
    subscriptionToProgram.set(String(message.result), program);
    emitStatus('subscribed', { program: program.label, subscriptionId: message.result });
    return Boolean(stats);
  }

  function handleNotification(message, raw) {
    if (message?.method !== 'transactionNotification') return false;
    const program = subscriptionToProgram.get(String(message?.params?.subscription));
    if (!program) return false;
    const stats = recordTraffic(program, raw, 'notificationBytes');
    stats.seen += 1;
    const value = message?.params?.result?.value || {};
    if (!wasProgramInvoked(value, program.address)) {
      stats.skippedMentionOnly += 1;
      stats.traffic.mentionOnlyBytes += getRawByteLength(raw);
      return true;
    }
    stats.matches += 1;
    stats.traffic.matchBytes += getRawByteLength(raw);
    onSummary(summarizeNotification(program, value, stats.seen, now()));
    return true;
  }

  function handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch (error) {
      onError(error);
      return;
    }
    if (handleSubscriptionResponse(message, raw)) return;
    handleNotification(message, raw);
  }

  function connect() {
    if (stopped) return;
    ws = wsFactory(options.wsUrl);
    emitStatus('connecting');
    ws.on('open', () => {
      reconnectDelayMs = Number(options.reconnectDelayMs) || DEFAULT_RECONNECT_DELAY_MS;
      emitStatus('connected');
      sendSubscriptions();
    });
    ws.on('message', handleMessage);
    ws.on('error', onError);
    ws.on('close', () => {
      emitStatus('closed');
      scheduleReconnect();
    });
  }

  function stop() {
    stopped = true;
    if (reconnectTimer) cancelSchedule(reconnectTimer);
    reconnectTimer = null;
    try {
      if (ws?.readyState === WebSocket.OPEN) {
        for (const subscriptionId of subscriptionToProgram.keys()) {
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: 10_000 + Number(subscriptionId),
            method: 'transactionUnsubscribe',
            params: [Number(subscriptionId)],
          }));
        }
      }
      ws?.close();
    } catch (error) {
      onError(error);
    }
  }

  return {
    start: connect,
    stop,
    stats: () => [...statsByProgram.values()],
  };
}

module.exports = {
  createOnchainTransactionStream,
};
