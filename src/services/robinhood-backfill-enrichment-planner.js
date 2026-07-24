const MAX_RPC_BATCH_SIZE = 100;

function quantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw) && !/^0x[0-9a-f]+$/i.test(raw)) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return BigInt(raw);
}

function tokenAddress(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new TypeError('tokenAddress must be a 20-byte hex address');
  }
  return normalized;
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => (
      item === undefined ? 'null' : canonicalJson(item)
    )).join(',')}]`;
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON-RPC params must contain finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value === 'object') {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  throw new TypeError('JSON-RPC params contain an unsupported value');
}

function batchLimit(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return Math.min(MAX_RPC_BATCH_SIZE, parsed);
}

function compareItems(left, right) {
  if (left.tokenAddress !== right.tokenAddress) {
    return left.tokenAddress < right.tokenAddress ? -1 : 1;
  }
  if (left.block !== right.block) return left.block < right.block ? -1 : 1;
  if (left.index !== right.index) return left.index < right.index ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function normalizeRequest(request, defaultProvider) {
  const slot = String(request?.slot || '').trim();
  const method = String(request?.method || '').trim();
  const params = request?.params ?? [];
  const rawProvider = request?.provider ?? defaultProvider;
  const provider = rawProvider == null ? null : String(rawProvider).trim();
  if (!slot) throw new TypeError('Every dependency requires a slot');
  if (!method) throw new TypeError(`Dependency ${slot} requires a JSON-RPC method`);
  if (!Array.isArray(params) && (params == null || typeof params !== 'object')) {
    throw new TypeError(`Dependency ${slot} has invalid JSON-RPC params`);
  }
  if (rawProvider != null && !provider) {
    throw new TypeError(`Dependency ${slot} has an empty provider`);
  }
  return { slot, method, params, provider };
}

function normalizeItem(item, defaultProvider) {
  const id = String(item?.id ?? '').trim();
  if (!id) throw new TypeError('Every enrichment item requires an id');
  if (!Array.isArray(item?.requests)) {
    throw new TypeError(`Enrichment item ${id} requires a requests array`);
  }
  const requests = item.requests.map((request) => normalizeRequest(request, defaultProvider));
  const slots = new Set();
  for (const request of requests) {
    if (slots.has(request.slot)) throw new TypeError(`Enrichment item ${id} repeats slot ${request.slot}`);
    slots.add(request.slot);
  }
  const block = quantity(item.blockNumber, `Enrichment item ${id} blockNumber`);
  const index = quantity(item.logIndex, `Enrichment item ${id} logIndex`);
  return {
    id,
    tokenAddress: tokenAddress(item.tokenAddress),
    block,
    index,
    blockNumber: block.toString(),
    logIndex: index.toString(),
    requests,
  };
}

function requestIdentity(request) {
  return `${request.provider || ''}\u0000${request.method}\u0000${canonicalJson(request.params)}`;
}

function createBatches(calls, options) {
  const defaultLimit = batchLimit(options.batchSize ?? MAX_RPC_BATCH_SIZE, 'batchSize');
  const providerLimits = options.providerBatchSizes || {};
  if (providerLimits == null || Array.isArray(providerLimits) || typeof providerLimits !== 'object') {
    throw new TypeError('providerBatchSizes must be an object');
  }
  const groups = new Map();
  for (const call of calls) {
    const key = call.provider || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(call);
  }
  const batches = [];
  for (const [providerKey, groupCalls] of groups) {
    const provider = providerKey || null;
    const configured = provider && Object.hasOwn(providerLimits, provider)
      ? providerLimits[provider]
      : defaultLimit;
    const limit = batchLimit(configured, `Batch limit for ${provider || 'default provider'}`);
    for (let offset = 0; offset < groupCalls.length; offset += limit) {
      batches.push({
        provider,
        calls: groupCalls.slice(offset, offset + limit),
      });
    }
  }
  return batches;
}

function planRobinhoodBackfillEnrichment(input, options = {}) {
  if (!Array.isArray(input)) throw new TypeError('Enrichment input must be an array');
  const items = input.map((item) => normalizeItem(item, options.defaultProvider)).sort(compareItems);
  const ids = new Set();
  const callsByIdentity = new Map();
  const plannedItems = items.map((item) => {
    if (ids.has(item.id)) throw new TypeError(`Duplicate enrichment item id: ${item.id}`);
    ids.add(item.id);
    const dependencies = item.requests.map((request) => {
      const identity = requestIdentity(request);
      let call = callsByIdentity.get(identity);
      if (!call) {
        call = {
          id: `rpc-${callsByIdentity.size + 1}`,
          provider: request.provider,
          method: request.method,
          params: request.params,
        };
        callsByIdentity.set(identity, call);
      }
      return { slot: request.slot, callId: call.id };
    });
    return {
      id: item.id,
      tokenAddress: item.tokenAddress,
      blockNumber: item.blockNumber,
      logIndex: item.logIndex,
      dependencies,
    };
  });
  const calls = [...callsByIdentity.values()];
  return {
    items: plannedItems,
    calls,
    batches: createBatches(calls, options),
  };
}

async function requestIndividually(rpcClient, calls, results, metrics) {
  for (const call of calls) {
    if (call.provider && typeof rpcClient.requestProvider !== 'function') {
      throw new TypeError('rpcClient.requestProvider is required for routed dependencies');
    }
    const value = call.provider
      ? await rpcClient.requestProvider(call.provider, call.method, call.params)
      : await rpcClient.request(call.method, call.params);
    results.set(call.id, value);
    metrics.individualRequests += 1;
  }
}

function canRequestBatch(rpcClient, batch, options, batchDisabled) {
  if (options.useBatch === false || batch.calls.length < 2 || batchDisabled) return false;
  return typeof rpcClient[batch.provider ? 'requestBatchProvider' : 'requestBatch'] === 'function';
}

function requestBatch(rpcClient, batch) {
  const requests = batch.calls.map(({ method, params }) => ({ method, params }));
  return batch.provider
    ? rpcClient.requestBatchProvider(batch.provider, requests)
    : rpcClient.requestBatch(requests);
}

async function executeRobinhoodBackfillEnrichmentPlan(plan, rpcClient, options = {}) {
  if (!Array.isArray(plan?.items) || !Array.isArray(plan?.batches)) {
    throw new TypeError('A valid enrichment plan is required');
  }
  if (typeof rpcClient?.request !== 'function') throw new TypeError('rpcClient.request is required');
  const results = new Map();
  const metrics = { batches: 0, batchItems: 0, individualRequests: 0, batchFallbacks: 0 };
  const batchDisabledProviders = new Set();
  for (const batch of plan.batches) {
    const providerKey = batch.provider || '';
    if (!canRequestBatch(rpcClient, batch, options, batchDisabledProviders.has(providerKey))) {
      await requestIndividually(rpcClient, batch.calls, results, metrics);
      continue;
    }
    try {
      const values = await requestBatch(rpcClient, batch);
      if (!Array.isArray(values) || values.length !== batch.calls.length) {
        throw new Error('JSON-RPC batch returned an invalid result count');
      }
      batch.calls.forEach((call, index) => results.set(call.id, values[index]));
      metrics.batches += 1;
      metrics.batchItems += batch.calls.length;
    } catch (error) {
      if (error?.code !== 'batch_unsupported') throw error;
      batchDisabledProviders.add(providerKey);
      metrics.batchFallbacks += 1;
      await requestIndividually(rpcClient, batch.calls, results, metrics);
    }
  }
  return {
    items: plan.items.map((item) => ({
      id: item.id,
      tokenAddress: item.tokenAddress,
      blockNumber: item.blockNumber,
      logIndex: item.logIndex,
      results: Object.fromEntries(item.dependencies.map(
        ({ slot, callId }) => [slot, results.get(callId)]
      )),
    })),
    metrics,
  };
}

module.exports = {
  MAX_RPC_BATCH_SIZE,
  executeRobinhoodBackfillEnrichmentPlan,
  planRobinhoodBackfillEnrichment,
};
