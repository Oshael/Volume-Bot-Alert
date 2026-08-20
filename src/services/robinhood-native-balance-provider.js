const { createEvmJsonRpcClient } = require('./evm-json-rpc-client');

const MAX_ADDRESSES = 50;
const MAX_CACHE_ENTRIES = 10_000;
const DEFAULT_CACHE_TTL_MS = 30_000;

function address(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new Error('native balance address must be a 20-byte address');
  }
  return normalized;
}

function balanceRaw(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(normalized)) {
    throw new Error('eth_getBalance returned an invalid quantity');
  }
  return BigInt(normalized).toString();
}

function boundedTtl(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    ? Math.max(1000, Math.min(parsed, 300_000)) : DEFAULT_CACHE_TTL_MS;
}

function createRobinhoodNativeBalanceProvider(options = {}) {
  const rpcClient = options.rpcClient || createEvmJsonRpcClient({
    providers: [{ name: 'robinhood-native-local', url: options.rpcUrl }],
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    minRequestIntervalMs: 0,
  });
  if (typeof rpcClient?.requestBatch !== 'function') {
    throw new TypeError('native balance provider requires RPC batch support');
  }
  const cacheTtlMs = boundedTtl(options.cacheTtlMs);
  const now = options.now || Date.now;
  const cache = new Map();

  async function readBalances(inputs = []) {
    if (!Array.isArray(inputs)) throw new TypeError('native balance addresses must be a list');
    const addresses = [...new Set(inputs.map(address))];
    if (addresses.length > MAX_ADDRESSES) {
      throw new RangeError(`native balance addresses exceed ${MAX_ADDRESSES}`);
    }
    const at = now();
    const missing = addresses.filter((item) => (cache.get(item)?.expiresAt || 0) <= at);
    if (missing.length > 0) {
      const results = await rpcClient.requestBatch(missing.map((walletAddress) => ({
        method: 'eth_getBalance', params: [walletAddress, 'latest'],
      })));
      if (!Array.isArray(results) || results.length !== missing.length) {
        throw new Error('eth_getBalance batch returned an invalid result count');
      }
      missing.forEach((walletAddress, index) => {
        while (!cache.has(walletAddress) && cache.size >= MAX_CACHE_ENTRIES) {
          cache.delete(cache.keys().next().value);
        }
        cache.set(walletAddress, {
          balanceRaw: balanceRaw(results[index]), expiresAt: at + cacheTtlMs,
        });
      });
    }
    return Object.freeze(Object.fromEntries(addresses.map((walletAddress) => (
      [walletAddress, cache.get(walletAddress).balanceRaw]
    ))));
  }

  return Object.freeze({ readBalances });
}

module.exports = {
  createRobinhoodNativeBalanceProvider,
  __private: { address, balanceRaw },
};
