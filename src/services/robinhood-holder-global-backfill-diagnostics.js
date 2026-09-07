// In-memory observations published by the existing worker lease heartbeat.
// Only allowlisted identifiers/counts are retained, never RPC URLs or payloads.
function block(value) {
  const raw = String(value ?? '');
  return /^(0x[0-9a-f]+|\d+)$/i.test(raw) ? BigInt(raw).toString() : null;
}

function rangeDetails(input = {}) {
  input ||= {};
  return {
    runId: block(input.runId), fromBlock: block(input.fromBlock),
    toBlock: block(input.toBlock),
    tokenAddress: /^0x[0-9a-f]{40}$/i.test(input.tokenAddress || '')
      ? input.tokenAddress : null,
    scopeTokens: Array.isArray(input.tokenAddresses) ? input.tokenAddresses.length : null,
  };
}

function rpcDetails(method, params = []) {
  if (method === 'eth_getLogs') {
    const filter = params[0] || {};
    return { ...rangeDetails(filter), filterMode: filter.address ? 'address-filtered' : 'topics-only',
      addressCount: Array.isArray(filter.address)
      ? filter.address.length : filter.address ? 1 : 0 };
  }
  return { block: block(params[0]) };
}

function operationDetails(group, method, args) {
  if (group !== 'rpc') return rangeDetails(args[0]);
  if (method === 'requestBatch') {
    const batch = args[0];
    return {
      method: batch[0]?.method, batchSize: batch.length,
      fromBlock: block(batch[0]?.params?.[0]),
      toBlock: block(batch.at(-1)?.params?.[0]),
    };
  }
  return { method: args[0], ...rpcDetails(args[0], args[1]) };
}

function createRobinhoodHolderGlobalBackfillDiagnostics({ now = Date.now } = {}) {
  const active = new Map();
  let sequence = 0;
  let tickStartedAt = null;
  let tickFinishedAt = null;
  let run = null;
  let completedOperations = 0;
  let failedOperations = 0;
  let lastCompleted = null;
  let lastFailure = null;
  let rpcClient;

  function startTick() {
    tickStartedAt = now(); tickFinishedAt = null; run = null;
    completedOperations = 0; failedOperations = 0;
    lastCompleted = null; lastFailure = null;
  }

  async function track(group, operation, details, invoke) {
    const id = ++sequence;
    const entry = { group, operation, ...details, startedAt: now() };
    active.set(id, entry);
    try {
      const result = await invoke();
      completedOperations += 1;
      lastCompleted = { ...entry, durationMs: now() - entry.startedAt,
        finishedAt: now() };
      if (group === 'lifecycle' && operation === 'getLatestRun' && result) {
        run = { id: result.id, status: result.status, nextBlock: result.nextBlock,
          barrierBlock: result.barrierBlock };
      }
      return result;
    } catch (error) {
      failedOperations += 1;
      lastFailure = { ...entry, durationMs: now() - entry.startedAt,
        finishedAt: now(), code: String(error.code || 'operation_error').slice(0, 80) };
      throw error;
    } finally {
      active.delete(id);
    }
  }

  function wrap(target, group) {
    if (group === 'rpc') rpcClient = target;
    return Object.fromEntries(Object.entries(target).map(([method, value]) => {
      if (typeof value !== 'function' || method === 'getStatus' || method === 'getMetrics'
          || (group === 'rpc' && !['request', 'requestBatch'].includes(method))) return [method, value];
      return [method, (...args) => track(group, method,
        operationDetails(group, method, args), () => value.apply(target, args))];
    }));
  }

  function snapshot() {
    const observedAt = now();
    const entries = [...active.values()];
    const summarize = (isRpc) => entries.filter((entry) => (entry.group === 'rpc') === isRpc)
      .slice(0, 8).map((entry) => ({ ...entry, elapsedMs: observedAt - entry.startedAt }));
    return {
      observedAt, tickStartedAt, tickFinishedAt,
      tickElapsedMs: tickStartedAt == null ? null
        : (tickFinishedAt ?? observedAt) - tickStartedAt,
      run: run ? { ...run } : null, activeCount: entries.length,
      activeOperations: summarize(false), activeRpc: summarize(true),
      completedOperations, failedOperations,
      lastCompleted: lastCompleted ? { ...lastCompleted } : null,
      lastFailure: lastFailure ? { ...lastFailure } : null,
      rpcMetrics: rpcClient?.getMetrics?.() || null,
    };
  }

  return { startTick, finishTick: () => { tickFinishedAt = now(); }, track, wrap, snapshot };
}

module.exports = { createRobinhoodHolderGlobalBackfillDiagnostics };
