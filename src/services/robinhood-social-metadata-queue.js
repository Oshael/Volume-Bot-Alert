const dexscreener = require('./dexscreener');
const { extractDexSocialLinks } = require('../utils/dex-social-links');
const { sanitizeAssetUrl } = require('../utils/url-safety');
const { normalizeTokenAddress } = require('../utils/token-identity');

const RETRY_DELAYS_MS = Object.freeze([5 * 60_000, 30 * 60_000, 6 * 60 * 60_000]);

function normalizeAddress(value) {
  return normalizeTokenAddress('robinhood', value);
}

function createMemoryMetadataStore(options = {}) {
  const now = options.now || Date.now;
  const values = new Map();
  return Object.freeze({
    get: async (address) => {
      const entry = values.get(address);
      if (!entry) return null;
      if (entry.expiresAtMs <= now()) {
        values.delete(address);
        return null;
      }
      return { ...entry.value };
    },
    set: async (address, value, expiresAtMs) => {
      values.set(address, { value: { ...value }, expiresAtMs });
    },
    markChecked: async (address, expiresAtMs) => {
      values.set(address, { value: { chain: 'robinhood', address }, expiresAtMs });
    },
    size: () => values.size,
  });
}

function extractRobinhoodSocialMetadata(address, pair, nowMs) {
  if (!pair) return null;
  const links = extractDexSocialLinks(pair);
  const metadata = {
    chain: 'robinhood',
    address,
    source: 'dexscreener',
    pairAddress: pair.pairAddress || null,
    imageUrl: sanitizeAssetUrl(pair.info?.imageUrl),
    websiteUrl: links.websiteUrl,
    twitterUrl: links.twitterUrl,
    telegramUrl: links.telegramUrl,
    fetchedAtMs: nowMs,
  };
  return metadata.imageUrl || metadata.websiteUrl || metadata.twitterUrl || metadata.telegramUrl
    ? metadata
    : null;
}

function createRobinhoodSocialMetadataQueue(options = {}) {
  const dexClient = options.dexClient || dexscreener;
  if (typeof dexClient.batchGetTokens !== 'function' || typeof dexClient.getBestPair !== 'function') {
    throw new Error('DexScreener batchGetTokens and getBestPair are required');
  }
  const now = options.now || Date.now;
  const store = options.store || createMemoryMetadataStore({ now });
  const cacheTtlMs = Math.max(60_000, Number(options.cacheTtlMs) || 24 * 60 * 60_000);
  const maxBatchSize = Math.max(1, Math.min(5, Number(options.maxBatchSize) || 5));
  const maxQueueSize = Math.max(maxBatchSize, Number(options.maxQueueSize) || 1000);
  const minDrainIntervalMs = Math.max(60_000, Number(options.minDrainIntervalMs) || 60_000);
  const retryDelaysMs = options.retryDelaysMs || RETRY_DELAYS_MS;
  const queue = new Map();
  const metrics = {
    enqueued: 0, duplicates: 0, dropped: 0, cacheHits: 0, fetched: 0,
    resolved: 0, unavailable: 0, retries: 0, pauses: 0, errors: 0,
  };
  let draining = false;
  let lastDrainAtMs = null;

  function enqueue(tokenAddress, priority = {}) {
    const address = normalizeAddress(tokenAddress);
    if (queue.has(address)) {
      const existing = queue.get(address);
      existing.blockscoutMissingImage ||= priority.blockscoutMissingImage === true;
      existing.volumeUsd = Math.max(existing.volumeUsd, Number(priority.volumeUsd) || 0);
      metrics.duplicates += 1;
      return false;
    }
    if (queue.size >= maxQueueSize) {
      metrics.dropped += 1;
      return false;
    }
    queue.set(address, {
      address,
      attempts: 0,
      nextAttemptAtMs: now(),
      blockscoutMissingImage: priority.blockscoutMissingImage === true,
      volumeUsd: Math.max(0, Number(priority.volumeUsd) || 0),
    });
    metrics.enqueued += 1;
    return true;
  }

  function scheduleRetry(entry) {
    const delay = retryDelaysMs[entry.attempts - 1];
    if (!Number.isFinite(delay)) {
      queue.delete(entry.address);
      metrics.unavailable += 1;
      return true;
    }
    entry.nextAttemptAtMs = now() + Math.max(60_000, delay);
    metrics.retries += 1;
    return false;
  }

  async function loadCandidates() {
    const ready = [...queue.values()]
      .filter((entry) => entry.nextAttemptAtMs <= now())
      .sort((left, right) => (
        Number(right.blockscoutMissingImage) - Number(left.blockscoutMissingImage)
        || right.volumeUsd - left.volumeUsd
        || left.address.localeCompare(right.address)
      ))
      .slice(0, maxBatchSize);
    const candidates = [];
    for (const entry of ready) {
      const cached = await store.get(entry.address);
      if (cached) {
        queue.delete(entry.address);
        metrics.cacheHits += 1;
      } else {
        candidates.push(entry);
      }
    }
    return candidates;
  }

  async function fetchCandidates(candidates) {
    const addresses = candidates.map((entry) => entry.address);
    const priorityByAddress = new Map(addresses.map((address) => [address, 'dormant']));
    const results = await dexClient.batchGetTokens(addresses, {
      chain: 'robinhood', delayMs: 0, priorityByAddress,
    });
    metrics.fetched += addresses.length;
    for (const entry of candidates) {
      entry.attempts += 1;
      const pair = dexClient.getBestPair(results.get(entry.address), 'robinhood');
      const metadata = extractRobinhoodSocialMetadata(entry.address, pair, now());
      if (!metadata) {
        const exhausted = scheduleRetry(entry);
        if (exhausted) await store.markChecked?.(entry.address, now() + cacheTtlMs);
        continue;
      }
      await store.set(entry.address, metadata, now() + cacheTtlMs);
      queue.delete(entry.address);
      metrics.resolved += 1;
    }
  }

  async function drainOnce() {
    if (draining) return { status: 'busy', processed: 0 };
    const throttle = dexClient.getThrottleState?.(now());
    if (throttle?.pauseDiscovery) {
      metrics.pauses += 1;
      return { status: 'paused', processed: 0 };
    }
    if (lastDrainAtMs != null && lastDrainAtMs + minDrainIntervalMs > now()) {
      return { status: 'cooldown', processed: 0 };
    }
    draining = true;
    try {
      const candidates = await loadCandidates();
      if (!candidates.length) return { status: 'idle', processed: 0 };
      lastDrainAtMs = now();
      try {
        await fetchCandidates(candidates);
        return { status: 'processed', processed: candidates.length };
      } catch (error) {
        metrics.errors += 1;
        for (const entry of candidates) {
          entry.attempts += 1;
          scheduleRetry(entry);
        }
        return { status: 'error', processed: 0, error: String(error.message || error) };
      }
    } finally {
      draining = false;
    }
  }

  function snapshot() {
    return {
      queued: queue.size,
      draining,
      maxBatchSize,
      maxQueueSize,
      cacheTtlMs,
      minDrainIntervalMs,
      lastDrainAtMs,
      metrics: { ...metrics },
    };
  }

  return Object.freeze({ drainOnce, enqueue, getMetadata: store.get, snapshot });
}

module.exports = {
  RETRY_DELAYS_MS,
  createMemoryMetadataStore,
  createRobinhoodSocialMetadataQueue,
  extractRobinhoodSocialMetadata,
  normalizeAddress,
};
