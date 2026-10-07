const { createHash } = require('node:crypto');
const db = require('../models/db');
const { normalizeTokenAddress, parseTokenIdentityKey } = require('../utils/token-identity');
const { createRobinhoodRadarGainersService } = require('./robinhood-radar-gainers');
const { getGainersReorgRevision, getGainersPriceRevision } = require('./robinhood-radar-gainers-generation');

const CACHE_TTL_MS = 5000;
const MIN_REFRESH_MS = 500;
const ERROR_BACKOFF_MS = 10000;
const MAX_CACHE_ENTRIES = 32;
const MAX_WAITERS = 32;
const MAX_EXCLUSIONS = 5000;

function failure(code, message, retryAfterSeconds) {
  return Object.assign(new Error(message), { code, retryAfterSeconds });
}

function parseRequest(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !['limit', 'dismissedIdentities'].includes(key))) {
      throw new Error('Only limit and dismissedIdentities are accepted');
    }
    const limit = input.limit ?? 15;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
      throw new Error('limit must be an integer between 1 and 20');
    }
    const dismissed = input.dismissedIdentities ?? [];
    if (!Array.isArray(dismissed) || dismissed.length > MAX_EXCLUSIONS) {
      throw new Error('dismissedIdentities cannot exceed 5000');
    }
    const addresses = dismissed.map((value) => {
      if (typeof value !== 'string') throw new Error('dismissedIdentities must contain identity keys');
      const identity = parseTokenIdentityKey(value);
      if (identity.chain !== 'robinhood') throw new Error('Only Robinhood identities are accepted');
      return identity.address;
    });
    return { limit, addresses };
  } catch (error) {
    throw failure('INVALID_GAINERS_REQUEST', error.message);
  }
}

function createRobinhoodRadarGainersPage(options = {}) {
  const service = options.service || createRobinhoodRadarGainersService();
  const database = options.database || db;
  const now = options.now || Date.now;
  const getReorgRevision = options.getReorgRevision || getGainersReorgRevision;
  const getPriceRevision = options.getPriceRevision || getGainersPriceRevision;
  const loadBlockedAddresses = options.loadBlockedAddresses || (async (userId) => {
    const { rows } = await database.queryWithStatementTimeout(
      `SELECT address FROM user_blocklist WHERE user_id = $1 AND chain = 'robinhood' LIMIT 5001`,
      [userId], 1000,
    );
    return rows.map((row) => row.address);
  });
  const cache = new Map();
  let active = null;
  let nextAllowedAt = 0;

  function busy(retryMs = 1000) {
    return failure('GAINERS_BUSY', 'Gainers refresh is busy; retry later',
      Math.max(1, Math.ceil(retryMs / 1000)));
  }

  async function join(state) {
    if (state.waiters >= MAX_WAITERS) throw busy();
    state.waiters += 1;
    try { return await state.promise; } finally { state.waiters -= 1; }
  }

  function remember(key, page) {
    const completedAt = now();
    for (const [storedKey, entry] of cache) {
      if (entry.expiresAt <= completedAt) cache.delete(storedKey);
    }
    const value = { ...page, source: 'robinhood-radar-gainers-v1',
      generatedAt: new Date(completedAt).toISOString() };
    cache.set(key, { page: value, expiresAt: completedAt + CACHE_TTL_MS });
    if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    return value;
  }

  function read(query, reorgRevision, priceRevision) {
    const currentTime = now();
    const key = createHash('sha256').update(JSON.stringify([
      query.excludedAddresses, reorgRevision, priceRevision,
    ])).digest('hex');
    const cached = cache.get(key);
    if (cached?.expiresAt > currentTime) return Promise.resolve(cached.page);
    cache.delete(key);
    if (active) return active.key === key ? join(active) : Promise.reject(busy());
    if (currentTime < nextAllowedAt) return Promise.reject(busy(nextAllowedAt - currentTime));
    nextAllowedAt = currentTime + MIN_REFRESH_MS;
    const state = { key, waiters: 0, promise: null };
    active = state;
    state.promise = Promise.resolve().then(() => service.getGainers(query))
      .then((page) => {
        if (getReorgRevision() !== reorgRevision) throw busy();
        return remember(key, page);
      })
      .catch((error) => {
        if (error.code !== 'GAINERS_BUSY') nextAllowedAt = now() + ERROR_BACKOFF_MS;
        throw error;
      }).finally(() => { active = null; });
    return join(state);
  }

  return {
    async list(userId, input = {}) {
      const { limit, addresses } = parseRequest(input);
      const blocked = await loadBlockedAddresses(userId);
      if (blocked.length > MAX_EXCLUSIONS) {
        throw failure('GAINERS_UNAVAILABLE', 'User exclusions exceed the supported bound', 10);
      }
      const excludedAddresses = [...new Set([...blocked, ...addresses]
        .map((address) => normalizeTokenAddress('robinhood', address)))].sort();
      if (excludedAddresses.length > MAX_EXCLUSIONS) {
        throw failure('INVALID_GAINERS_REQUEST', 'Combined exclusions cannot exceed 5000');
      }
      const reorgRevision = getReorgRevision();
      const page = await read({ asOf: new Date(now()).toISOString(), live: true,
        excludedAddresses, limit: 20 }, reorgRevision, getPriceRevision());
      if (getReorgRevision() !== reorgRevision) throw busy();
      const items = page.items.slice(0, limit);
      return { ...page, limit, items, hasMore: page.total > items.length,
        cacheAgeMs: Math.max(0, now() - Date.parse(page.generatedAt)) };
    },
  };
}

module.exports = { createRobinhoodRadarGainersPage };
