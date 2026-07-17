const WebSocket = require('ws');

const {
  createTrafficStats,
  getRawByteLength,
  summarizeNotification,
} = require('../utils/quicknode-transaction-probe');

const DEFAULT_RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_FETCH_CONCURRENCY = 2;
const DEFAULT_FETCH_BATCH_SIZE = 50;
const DEFAULT_FETCH_BATCH_WAIT_MS = 50;
const DEFAULT_FETCH_AVAILABILITY_DELAY_MS = 500;
const DEFAULT_FETCH_ATTEMPTS = 4;
const DEFAULT_FETCH_RETRY_MS = 250;
const DEFAULT_FETCH_MAX_QUEUE_SIZE = 2_000;
const SIGNATURE_TTL_MS = 10 * 60 * 1000;

function createProgramStats(program) {
  return {
    program: program.label,
    seen: 0,
    matches: 0,
    skippedMentionOnly: 0,
    traffic: createTrafficStats(),
  };
}

function hasProgramInvoke(logs, address) {
  const prefix = `Program ${address} invoke [`;
  return logs.some((line) => String(line || '').startsWith(prefix));
}

function buildFetchedValue(signature, transaction) {
  return {
    signature,
    slot: transaction?.slot || null,
    blockTime: transaction?.blockTime || null,
    error: transaction?.meta?.err || null,
    transaction: {
      meta: transaction?.meta || {},
      transaction: transaction?.transaction || {},
    },
  };
}

function readFetchOptions(options) {
  const configuredAvailabilityDelayMs = Number(options.fetchAvailabilityDelayMs);
  return {
    fetchConcurrency: Math.max(1, Number(options.fetchConcurrency) || DEFAULT_FETCH_CONCURRENCY),
    fetchBatchSize: Math.max(1, Number(options.fetchBatchSize) || DEFAULT_FETCH_BATCH_SIZE),
    fetchBatchWaitMs: Math.max(1, Number(options.fetchBatchWaitMs) || DEFAULT_FETCH_BATCH_WAIT_MS),
    fetchAvailabilityDelayMs: Number.isFinite(configuredAvailabilityDelayMs)
      ? Math.max(0, configuredAvailabilityDelayMs)
      : DEFAULT_FETCH_AVAILABILITY_DELAY_MS,
    fetchAttempts: Math.max(1, Number(options.fetchAttempts) || DEFAULT_FETCH_ATTEMPTS),
    fetchRetryMs: Math.max(1, Number(options.fetchRetryMs) || DEFAULT_FETCH_RETRY_MS),
    fetchMaxQueueSize: Math.max(1, Number(options.fetchMaxQueueSize) || DEFAULT_FETCH_MAX_QUEUE_SIZE),
  };
}

function createOnchainLogTransactionStream(options = {}) {
  const programs = Array.isArray(options.programs) ? options.programs : [];
  const wsFactory = options.wsFactory || ((url) => new WebSocket(url));
  const fetchImpl = options.fetchImpl || fetch;
  const schedule = options.schedule || setTimeout;
  const cancelSchedule = options.cancelSchedule || clearTimeout;
  const now = options.now || Date.now;
  const clock = options.clock || Date.now;
  const onSummary = options.onSummary || (() => {});
  const onStatus = options.onStatus || (() => {});
  const onError = options.onError || (() => {});
  const statsByProgram = new Map(programs.map((program) => [program.label, createProgramStats(program)]));
  const requestToProgram = new Map();
  const subscriptionToProgram = new Map();
  const seenSignatures = new Map();
  const fetchQueue = [];
  const httpStats = {
    requests: 0,
    methodCalls: 0,
    responseBytes: 0,
    fetched: 0,
    unavailable: 0,
    errors: 0,
    rateLimitedBatches: 0,
    dropped: 0,
  };
  const {
    fetchConcurrency,
    fetchBatchSize,
    fetchBatchWaitMs,
    fetchAvailabilityDelayMs,
    fetchAttempts,
    fetchRetryMs,
    fetchMaxQueueSize,
  } = readFetchOptions(options);
  const retryTimers = new Set();
  let activeFetches = 0;
  let fetchBatchTimer = null;
  let ws = null;
  let stopped = false;
  let reconnectTimer = null;
  let stopResolve = null;
  let reconnectDelayMs = Number(options.reconnectDelayMs) || DEFAULT_RECONNECT_DELAY_MS;

  function sendSubscriptions() {
    requestToProgram.clear();
    subscriptionToProgram.clear();
    programs.forEach((program, index) => {
      const id = index + 1;
      requestToProgram.set(id, program);
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'logsSubscribe',
        params: [{ mentions: [program.address] }, { commitment: 'confirmed' }],
      }));
    });
  }

  function recordTraffic(program, raw, bucket) {
    const stats = statsByProgram.get(program.label);
    const bytes = getRawByteLength(raw);
    stats.traffic.messages += 1;
    stats.traffic.receivedBytes += bytes;
    stats.traffic[bucket] += bytes;
    return { stats, bytes };
  }

  function pruneSignatures(nowMs) {
    const cutoff = nowMs - SIGNATURE_TTL_MS;
    for (const [signature, observedAtMs] of seenSignatures.entries()) {
      if (observedAtMs < cutoff) seenSignatures.delete(signature);
    }
  }

  function buildBatchPayload(items) {
    return items.map((item, index) => ({
      jsonrpc: '2.0',
      id: index + 1,
      method: 'getTransaction',
      params: [item.signature, {
        commitment: 'confirmed',
        encoding: 'jsonParsed',
        maxSupportedTransactionVersion: 0,
      }],
    }));
  }

  function scheduleRetry(items) {
    const retryable = items.filter((item) => item.attempt < fetchAttempts);
    const exhausted = items.length - retryable.length;
    httpStats.errors += exhausted;
    if (!retryable.length) return;
    const delayMs = fetchRetryMs * Math.max(...retryable.map((item) => item.attempt));
    const timer = schedule(() => {
      retryTimers.delete(timer);
      if (stopped) return;
      enqueueFetchItems(retryable.map((item) => ({
        ...item,
        attempt: item.attempt + 1,
        readyAtMs: clock(),
      })));
      scheduleFetchDrain();
    }, delayMs);
    retryTimers.add(timer);
  }

  function processBatchResults(items, body) {
    const responses = new Map((Array.isArray(body) ? body : [body]).map((item) => [Number(item?.id), item]));
    const retry = [];
    items.forEach((item, index) => {
      const response = responses.get(index + 1);
      if (response?.result) {
        httpStats.fetched += 1;
        const value = buildFetchedValue(item.signature, response.result);
        onSummary(summarizeNotification(item.program, value, item.seen, item.observedAtMs));
      } else if (item.attempt < fetchAttempts) {
        retry.push(item);
      } else if (response?.error) {
        httpStats.errors += 1;
      } else {
        httpStats.unavailable += 1;
      }
    });
    if (retry.length) scheduleRetry(retry);
  }

  async function fetchBatch(items) {
    httpStats.requests += 1;
    httpStats.methodCalls += items.length;
    try {
      const response = await fetchImpl(options.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify(buildBatchPayload(items)),
      });
      const text = await response.text();
      httpStats.responseBytes += Buffer.byteLength(text, 'utf8');
      if (response.status === 429) {
        httpStats.rateLimitedBatches += 1;
        scheduleRetry(items);
        return;
      }
      if (!response.ok) throw new Error(`getTransaction batch HTTP ${response.status}`);
      processBatchResults(items, JSON.parse(text));
    } catch (error) {
      scheduleRetry(items);
      onError(error);
    }
  }

  function drainFetchQueue() {
    if (fetchBatchTimer) cancelSchedule(fetchBatchTimer);
    fetchBatchTimer = null;
    while (!stopped && activeFetches < fetchConcurrency && fetchQueue.length) {
      const readyCount = fetchQueue.findIndex((item) => item.readyAtMs > clock());
      const available = readyCount === -1 ? fetchQueue.length : readyCount;
      if (available === 0) break;
      const items = fetchQueue.splice(0, Math.min(fetchBatchSize, available));
      activeFetches += 1;
      void fetchBatch(items).finally(() => {
        activeFetches -= 1;
        if (stopped && activeFetches === 0 && stopResolve) stopResolve();
        if (!stopped) scheduleFetchDrain();
      });
    }
    if (!stopped && fetchQueue.length && activeFetches < fetchConcurrency) scheduleFetchDrain();
  }

  function scheduleFetchDrain() {
    if (stopped || fetchBatchTimer || !fetchQueue.length) return;
    const untilReadyMs = Math.max(0, fetchQueue[0].readyAtMs - clock());
    if (untilReadyMs === 0 && fetchQueue.length >= fetchBatchSize && activeFetches < fetchConcurrency) {
      drainFetchQueue();
      return;
    }
    fetchBatchTimer = schedule(drainFetchQueue, Math.max(untilReadyMs, fetchBatchWaitMs));
  }

  function trimFetchQueue() {
    const overflow = fetchQueue.length - fetchMaxQueueSize;
    if (overflow <= 0) return;
    fetchQueue.splice(0, overflow);
    httpStats.dropped += overflow;
  }

  function enqueueFetchItems(items) {
    fetchQueue.push(...items);
    fetchQueue.sort((a, b) => a.readyAtMs - b.readyAtMs);
    trimFetchQueue();
    scheduleFetchDrain();
  }

  function enqueueFetch(item) {
    enqueueFetchItems([{
      ...item,
      attempt: 1,
      readyAtMs: clock() + fetchAvailabilityDelayMs,
    }]);
  }

  function handleSubscriptionResponse(message, raw) {
    const program = requestToProgram.get(Number(message.id));
    if (!program) return false;
    recordTraffic(program, raw, 'subscriptionBytes');
    if (message.error) onError(new Error(`${program.label} subscribe failed: ${message.error.message}`));
    else {
      subscriptionToProgram.set(String(message.result), program);
      onStatus({ status: 'subscribed', program: program.label, subscriptionId: message.result });
    }
    return true;
  }

  function handleNotification(message, raw) {
    if (message?.method !== 'logsNotification') return false;
    const program = subscriptionToProgram.get(String(message?.params?.subscription));
    if (!program) return false;
    const { stats, bytes } = recordTraffic(program, raw, 'notificationBytes');
    stats.seen += 1;
    const value = message?.params?.result?.value || {};
    const logs = Array.isArray(value.logs) ? value.logs : [];
    if (!hasProgramInvoke(logs, program.address)) {
      stats.skippedMentionOnly += 1;
      stats.traffic.mentionOnlyBytes += bytes;
      return true;
    }
    stats.matches += 1;
    stats.traffic.matchBytes += bytes;
    const signature = String(value.signature || '').trim();
    const observedAtMs = now();
    pruneSignatures(observedAtMs);
    if (!signature || seenSignatures.has(signature)) return true;
    seenSignatures.set(signature, observedAtMs);
    enqueueFetch({ signature, program, seen: stats.seen, observedAtMs });
    return true;
  }

  function handleMessage(raw) {
    try {
      const message = JSON.parse(String(raw));
      if (!handleSubscriptionResponse(message, raw)) handleNotification(message, raw);
    } catch (error) {
      onError(error);
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delayMs = reconnectDelayMs;
    onStatus({ status: 'reconnecting', delayMs });
    reconnectTimer = schedule(() => {
      reconnectTimer = null;
      connect();
    }, delayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
  }

  function connect() {
    if (stopped) return;
    ws = wsFactory(options.wsUrl);
    ws.on('open', () => {
      reconnectDelayMs = Number(options.reconnectDelayMs) || DEFAULT_RECONNECT_DELAY_MS;
      sendSubscriptions();
    });
    ws.on('message', handleMessage);
    ws.on('error', onError);
    ws.on('close', scheduleReconnect);
  }

  function stop() {
    stopped = true;
    if (reconnectTimer) cancelSchedule(reconnectTimer);
    reconnectTimer = null;
    if (fetchBatchTimer) cancelSchedule(fetchBatchTimer);
    fetchBatchTimer = null;
    for (const timer of retryTimers) cancelSchedule(timer);
    retryTimers.clear();
    fetchQueue.length = 0;
    try {
      ws?.close();
    } catch (error) {
      onError(error);
    }
    if (activeFetches === 0) return Promise.resolve();
    return new Promise((resolve) => { stopResolve = resolve; });
  }

  return {
    start: connect,
    stop,
    stats: () => [...statsByProgram.values()],
    httpStats: () => ({ ...httpStats, active: activeFetches, queued: fetchQueue.length }),
  };
}

module.exports = {
  createOnchainLogTransactionStream,
  __private: {
    buildFetchedValue,
    hasProgramInvoke,
  },
};
