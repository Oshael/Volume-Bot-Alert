const tokenCatalog = require('../models/token-catalog');
const workspaceChainReadiness = require('./workspace-chain-readiness');
const { createTokenIdentity } = require('../utils/token-identity');
const { normalizeGlobalSearchRequest } = require('./global-search-contract');

const MATCH_RANK = Object.freeze({ exact_address: 0, exact_ticker: 1, prefix: 2, text: 3 });
const GLOBAL_SEARCH_TIMEOUT_MS = 3000;

function optionalText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function createRobinhoodGlobalSearchAdapter(options = {}) {
  const catalog = options.tokenCatalog || tokenCatalog;
  return Object.freeze({
    chain: 'robinhood',
    addressFamilies: Object.freeze(['evm_address']),
    async resolveExactToken(input) {
      const row = await catalog.getByAddress(input.address, 'robinhood');
      if (!row) return [];
      const identity = createTokenIdentity('robinhood', row.address);
      return [{
        kind: 'token',
        chain: identity.chain,
        address: identity.address,
        symbol: optionalText(row.symbol),
        name: optionalText(row.name),
        imageUrl: optionalText(row.last_image_url ?? row.imageUrl),
        destination: { type: 'expanded-chart', chain: identity.chain, address: identity.address },
        match: 'exact_address',
      }];
    },
  });
}

function getAdapterKindMethod(adapter, kind, classification) {
  if (kind === 'wallet') return null;
  if (classification === 'text') return typeof adapter.searchTokens === 'function' ? 'searchTokens' : null;
  return adapter.addressFamilies?.includes(classification)
    && typeof adapter.resolveExactToken === 'function' ? 'resolveExactToken' : null;
}

function resolveAvailability(readiness, adapter, method) {
  if (!method) return 'unsupported';
  if (readiness?.status === 'syncing') return 'syncing';
  if (readiness?.status !== 'ready' || readiness?.capabilities?.monitored !== true) return 'unavailable';
  return 'ready';
}

function normalizeHit(hit, expectedKind, expectedChain) {
  if (
    hit?.kind !== expectedKind
    || hit?.chain !== expectedChain
    || !Object.prototype.hasOwnProperty.call(MATCH_RANK, hit?.match)
  ) {
    throw new Error('global search adapter returned an invalid hit');
  }
  const identity = createTokenIdentity(hit.chain, hit.address);
  if (hit.destination?.type !== 'expanded-chart' || expectedKind !== 'token') {
    throw new Error('global search adapter returned an unavailable destination');
  }
  return Object.freeze({ ...hit, chain: identity.chain, address: identity.address });
}

function compareHits(left, right) {
  return MATCH_RANK[left.match] - MATCH_RANK[right.match]
    || String(left.symbol || left.name || '').localeCompare(String(right.symbol || right.name || ''))
    || left.chain.localeCompare(right.chain)
    || left.address.localeCompare(right.address);
}

function aggregateStatus(chainStates) {
  const states = Object.values(chainStates).flatMap((entry) => Object.values(entry.kinds));
  if (states.includes('ready')) return 'ready';
  if (states.includes('syncing')) return 'syncing';
  if (states.includes('unavailable')) return 'unavailable';
  return 'unsupported';
}

function defaultAdapters(options) {
  return { robinhood: createRobinhoodGlobalSearchAdapter(options) };
}

function runAdapterWithTimeout(timeoutMs, externalSignal, operation) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  externalSignal?.addEventListener('abort', abort, { once: true });
  if (externalSignal?.aborted) abort();
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, timeoutMs);
  const aborted = new Promise((_, reject) => {
    const rejectAborted = () => reject(new Error('global search aborted'));
    if (controller.signal.aborted) rejectAborted();
    else controller.signal.addEventListener('abort', rejectAborted, { once: true });
  });
  return Promise.race([Promise.resolve().then(() => operation(controller.signal)), aborted])
    .catch((error) => {
      if (!timedOut) throw error;
      const timeoutError = new Error('global search adapter timed out');
      timeoutError.status = 504;
      throw timeoutError;
    })
    .finally(() => {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abort);
    });
}

function createGlobalSearchReader(options = {}) {
  const adapters = options.adapters || defaultAdapters(options);
  const readinessReader = options.workspaceChainReadiness || workspaceChainReadiness;
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || GLOBAL_SEARCH_TIMEOUT_MS);

  async function search(input = {}) {
    const request = normalizeGlobalSearchRequest(input);
    const readiness = await readinessReader.getWorkspaceChainReadiness();
    const operations = [];
    const chainStates = {};
    for (const chain of Object.keys(adapters).sort()) {
      const adapter = adapters[chain];
      const kinds = {};
      for (const kind of request.kinds) {
        const method = getAdapterKindMethod(adapter, kind, request.classification);
        kinds[kind] = resolveAvailability(readiness[chain], adapter, method);
        if (kinds[kind] === 'ready') {
          operations.push(runAdapterWithTimeout(timeoutMs, input.signal, (signal) => (
            adapter[method]({
              query: request.query,
              address: request.normalizedAddress,
              limit: request.limit,
              signal,
            })
          )).then((hits) => (hits || []).map((hit) => normalizeHit(hit, kind, chain))));
        }
      }
      chainStates[chain] = { kinds };
    }
    const hits = (await Promise.all(operations)).flat().sort(compareHits);
    const uniqueHits = [];
    const seen = new Set();
    for (const hit of hits) {
      const key = `${hit.kind}:${hit.chain}:${hit.address}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueHits.push(hit);
      if (uniqueHits.length >= request.limit) break;
    }
    return Object.freeze({
      query: request.query,
      classification: request.classification,
      kinds: request.kinds,
      limit: request.limit,
      status: aggregateStatus(chainStates),
      generatedAt: new Date().toISOString(),
      chainStates,
      count: uniqueHits.length,
      hits: uniqueHits,
    });
  }
  return Object.freeze({ search });
}

const globalSearchReader = createGlobalSearchReader();

module.exports = {
  GLOBAL_SEARCH_TIMEOUT_MS,
  ...globalSearchReader,
  createGlobalSearchReader,
  createRobinhoodGlobalSearchAdapter,
};
