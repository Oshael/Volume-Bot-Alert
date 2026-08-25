'use strict';

const {
  createCalloutRobinhoodEnrichmentRead,
} = require('../models/callout-robinhood-enrichment-read');

function chainKey(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) throw new TypeError('Callout enrichment chainKey is required');
  return normalized;
}

function pendingResult(key, tokenAddress = null) {
  return Object.freeze({
    status: 'pending', reason: 'adapter_unavailable', chainKey: key,
    tokenAddress, evidenceVersion: null, from: null, to: null,
    actions: Object.freeze([]), hasMore: false,
  });
}

function validateAdapterResult(result, expectedChain) {
  if (result?.status !== 'ready' || result.chainKey !== expectedChain
      || !Array.isArray(result.actions)) {
    throw new Error('Callout chain enrichment adapter returned an invalid contract');
  }
  return result;
}

function createCalloutChainEnrichment(options = {}) {
  const adapters = new Map(Object.entries(options.adapters || {
    robinhood: createCalloutRobinhoodEnrichmentRead(options.robinhood),
  }));

  async function listProfileWalletBuys(input = {}) {
    const key = chainKey(input.chainKey);
    const adapter = adapters.get(key);
    if (!adapter) return pendingResult(key, input.tokenAddress || null);
    return validateAdapterResult(await adapter.listProfileWalletBuys(input), key);
  }

  return Object.freeze({
    listProfileWalletBuys,
    availableChains: Object.freeze([...adapters.keys()].sort()),
  });
}

module.exports = {
  createCalloutChainEnrichment,
  __private: { chainKey, pendingResult, validateAdapterResult },
};
