const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const REQUEST_TIMEOUT = 10000;
const DEFAULT_CACHE_TTL_MS = 60000;
const ERROR_COOLDOWN_MS = 60000;
const TOKEN_BATCH_LIMIT = 30;
const MAX_TOKEN_CACHE_ENTRIES = 1500;
const MAX_ENDPOINT_CACHE_ENTRIES = 32;
const DEFAULT_BATCH_DELAY_MS = 100;
const RATE_LIMIT_BASE_BACKOFF_MS = 5000;
const RATE_LIMIT_MAX_BACKOFF_MS = 10 * 60 * 1000;
const RATE_LIMIT_JITTER_RATIO = 0.25;
const RATE_LIMIT_ACTIVATION_THRESHOLD = 10;
const COOLDOWN_BATCH_DELAY_MS = 400;
const RECOVERY_PHASES = [
  { name: 'high-manual', cycles: 5, batchDelayMs: 500 },
  { name: 'normal', cycles: 5, batchDelayMs: 350 },
  { name: 'low-near', cycles: 5, batchDelayMs: 200 },
  { name: 'low-dust', cycles: 5, batchDelayMs: 150 },
];

const tokenCache = new Map();
const endpointCache = new Map();
const inFlightRequests = new Map();
const endpointInFlightRequests = new Map();
const rateLimitState = {
  consecutive429s: 0,
  backoffUntil: 0,
  last429At: null,
  lastBackoffMs: 0,
  lastRetryAfterMs: null,
  lastContext: null,
  recoveryPhaseIndex: -1,
  recoveryCyclesRemaining: 0,
  recoveryCycleCounter: 0,
  lastCooldownStartedAt: null,
  lastRecoveryStartedAt: null,
};

function pruneCacheMap(cache, maxEntries) {
  const now = Date.now();

  for (const [key, entry] of cache.entries()) {
    if (!entry || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) {
      cache.delete(key);
    }
  }

  if (cache.size <= maxEntries) {
    return;
  }

  const overflow = cache.size - maxEntries;
  const removable = Array.from(cache.entries())
    .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
    .slice(0, overflow);

  for (const [key] of removable) {
    cache.delete(key);
  }
}

function getCacheEntry(address) {
  const entry = tokenCache.get(address);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    tokenCache.delete(address);
    return null;
  }
  return entry;
}

function setCacheEntry(address, data, ttlMs) {
  tokenCache.set(address, {
    data,
    expiresAt: Date.now() + ttlMs,
  });
  pruneCacheMap(tokenCache, MAX_TOKEN_CACHE_ENTRIES);
}

function getTokenCacheTtl(priorityHint) {
  switch (String(priorityHint || '').trim().toLowerCase()) {
    case 'high-hot':
      return 2 * 1000;
    case 'high-warm':
      return 3 * 1000;
    case 'high-cold':
      return 5 * 1000;
    case 'normal':
      return 4 * 1000;
    case 'low-near':
      return 15 * 1000;
    case 'low-dust':
      return 10 * 60 * 1000;
    case 'low-activity':
      return 3 * 60 * 1000;
    case 'dormant':
      return 30 * 60 * 1000;
    default:
      return DEFAULT_CACHE_TTL_MS;
  }
}

function clampRateLimitBackoffMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return RATE_LIMIT_BASE_BACKOFF_MS;
  }
  return Math.min(RATE_LIMIT_MAX_BACKOFF_MS, Math.max(1000, Math.round(parsed)));
}

function parseRetryAfterMs(value, now = Date.now()) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return clampRateLimitBackoffMs(seconds * 1000);
  }

  const at = Date.parse(raw);
  if (!Number.isFinite(at)) {
    return null;
  }

  return clampRateLimitBackoffMs(at - now);
}

function addRateLimitJitter(baseMs, randomValue = Math.random()) {
  const safeBaseMs = clampRateLimitBackoffMs(baseMs);
  const clampedRandom = Number.isFinite(randomValue)
    ? Math.max(0, Math.min(1, randomValue))
    : 0;
  const amplitudeMs = Math.round(safeBaseMs * RATE_LIMIT_JITTER_RATIO);
  return clampRateLimitBackoffMs(safeBaseMs + Math.round(amplitudeMs * clampedRandom));
}

function computeRateLimitBackoffMs(retryAfterMs, consecutive429s, randomValue = Math.random()) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return clampRateLimitBackoffMs(retryAfterMs);
  }

  const exponent = Math.max(0, Math.min(7, Math.trunc(Number(consecutive429s) || 0) - 1));
  const baseMs = RATE_LIMIT_BASE_BACKOFF_MS * (2 ** exponent);
  return addRateLimitJitter(baseMs, randomValue);
}

function getRateLimitBackoffRemainingMs(now = Date.now()) {
  return Math.max(0, (Number(rateLimitState.backoffUntil) || 0) - now);
}

function isRateLimitBackoffActive(now = Date.now()) {
  return getRateLimitBackoffRemainingMs(now) > 0;
}

function getRecoveryPhase() {
  if (!Number.isInteger(rateLimitState.recoveryPhaseIndex) || rateLimitState.recoveryPhaseIndex < 0) {
    return null;
  }

  return RECOVERY_PHASES[rateLimitState.recoveryPhaseIndex] || null;
}

function isRecoveryActive(now = Date.now()) {
  maybePromoteCooldownToRecovery(now);
  return Boolean(getRecoveryPhase());
}

function getRateLimitCooldownCacheTtlMs(now = Date.now()) {
  const remainingMs = getRateLimitBackoffRemainingMs(now);
  if (remainingMs > 0) {
    return clampRateLimitBackoffMs(remainingMs);
  }
  return ERROR_COOLDOWN_MS;
}

function startRecovery(now = Date.now()) {
  if (!RECOVERY_PHASES.length) {
    rateLimitState.recoveryPhaseIndex = -1;
    rateLimitState.recoveryCyclesRemaining = 0;
    rateLimitState.recoveryCycleCounter = 0;
    rateLimitState.lastRecoveryStartedAt = null;
    return;
  }

  rateLimitState.recoveryPhaseIndex = 0;
  rateLimitState.recoveryCyclesRemaining = RECOVERY_PHASES[0].cycles;
  rateLimitState.recoveryCycleCounter = 0;
  rateLimitState.lastRecoveryStartedAt = new Date(now).toISOString();
}

function clearRecoveryState() {
  rateLimitState.recoveryPhaseIndex = -1;
  rateLimitState.recoveryCyclesRemaining = 0;
  rateLimitState.recoveryCycleCounter = 0;
  rateLimitState.lastRecoveryStartedAt = null;
}

function maybePromoteCooldownToRecovery(now = Date.now()) {
  if (isRateLimitBackoffActive(now)) {
    return;
  }

  if ((Number(rateLimitState.backoffUntil) || 0) > 0) {
    rateLimitState.backoffUntil = 0;
    rateLimitState.lastBackoffMs = 0;
    rateLimitState.lastRetryAfterMs = null;
    if (!getRecoveryPhase()) {
      startRecovery(now);
    }
  }
}

function completeRecoveryCycle(now = Date.now()) {
  maybePromoteCooldownToRecovery(now);
  const phase = getRecoveryPhase();
  if (!phase) {
    return null;
  }

  rateLimitState.recoveryCycleCounter += 1;
  rateLimitState.recoveryCyclesRemaining = Math.max(0, rateLimitState.recoveryCyclesRemaining - 1);

  if (rateLimitState.recoveryCyclesRemaining > 0) {
    return getRecoveryPhase();
  }

  const nextPhaseIndex = rateLimitState.recoveryPhaseIndex + 1;
  if (nextPhaseIndex >= RECOVERY_PHASES.length) {
    clearRecoveryState();
    return null;
  }

  rateLimitState.recoveryPhaseIndex = nextPhaseIndex;
  rateLimitState.recoveryCyclesRemaining = RECOVERY_PHASES[nextPhaseIndex].cycles;
  return getRecoveryPhase();
}

function getThrottleState(now = Date.now()) {
  maybePromoteCooldownToRecovery(now);
  const recoveryPhase = getRecoveryPhase();

  if (isRateLimitBackoffActive(now)) {
    return {
      mode: 'cooldown',
      batchDelayMs: COOLDOWN_BATCH_DELAY_MS,
      backoffRemainingMs: getRateLimitBackoffRemainingMs(now),
      consecutive429s: rateLimitState.consecutive429s,
      recoveryPhase: null,
      pauseDiscovery: true,
    };
  }

  if (recoveryPhase) {
    return {
      mode: 'recovery',
      batchDelayMs: recoveryPhase.batchDelayMs,
      backoffRemainingMs: 0,
      consecutive429s: rateLimitState.consecutive429s,
      recoveryPhase: recoveryPhase.name,
      recoveryCyclesRemaining: rateLimitState.recoveryCyclesRemaining,
      recoveryCycleCounter: rateLimitState.recoveryCycleCounter,
      pauseDiscovery: true,
    };
  }

  return {
    mode: 'normal',
    batchDelayMs: DEFAULT_BATCH_DELAY_MS,
    backoffRemainingMs: 0,
    consecutive429s: rateLimitState.consecutive429s,
    recoveryPhase: null,
    recoveryCyclesRemaining: 0,
    recoveryCycleCounter: rateLimitState.recoveryCycleCounter,
    pauseDiscovery: false,
  };
}

function noteRateLimit(response, context) {
  const retryAfterMs = parseRetryAfterMs(response?.headers?.get('retry-after'));
  const consecutive429s = rateLimitState.consecutive429s + 1;
  const now = Date.now();
  const shouldActivateCooldown = consecutive429s >= RATE_LIMIT_ACTIVATION_THRESHOLD;
  const backoffMs = shouldActivateCooldown
    ? computeRateLimitBackoffMs(retryAfterMs, consecutive429s)
    : 0;
  const backoffUntil = shouldActivateCooldown ? now + backoffMs : 0;

  rateLimitState.consecutive429s = consecutive429s;
  rateLimitState.last429At = new Date(now).toISOString();
  rateLimitState.lastBackoffMs = backoffMs;
  rateLimitState.lastRetryAfterMs = retryAfterMs;
  rateLimitState.lastContext = context || null;
  if (shouldActivateCooldown) {
    rateLimitState.backoffUntil = Math.max(Number(rateLimitState.backoffUntil) || 0, backoffUntil);
    rateLimitState.lastCooldownStartedAt = new Date(now).toISOString();
    clearRecoveryState();
  }

  const retryAfterLabel = retryAfterMs != null ? ` retry-after=${retryAfterMs}ms` : '';
  if (shouldActivateCooldown) {
    console.warn(`[DexScreener] 429 on ${context}; cooldown activated after ${consecutive429s} consecutive 429s for ${backoffMs}ms.${retryAfterLabel}`);
  } else {
    console.warn(`[DexScreener] 429 on ${context}; consecutive429s=${consecutive429s}/${RATE_LIMIT_ACTIVATION_THRESHOLD}.${retryAfterLabel}`);
  }
  return {
    activatedCooldown: shouldActivateCooldown,
    backoffMs,
    retryAfterMs,
    consecutive429s,
  };
}

function noteSuccessfulResponse() {
  if (isRateLimitBackoffActive()) {
    return;
  }

  rateLimitState.consecutive429s = 0;
}

function getRateLimitState() {
  const throttleState = getThrottleState();
  return {
    active: isRateLimitBackoffActive(),
    mode: throttleState.mode,
    throttleActive: throttleState.mode !== 'normal',
    backoffRemainingMs: throttleState.backoffRemainingMs,
    consecutive429s: rateLimitState.consecutive429s,
    last429At: rateLimitState.last429At,
    lastBackoffMs: rateLimitState.lastBackoffMs,
    lastRetryAfterMs: rateLimitState.lastRetryAfterMs,
    lastContext: rateLimitState.lastContext,
    activationThreshold: RATE_LIMIT_ACTIVATION_THRESHOLD,
    recoveryPhase: throttleState.recoveryPhase,
    recoveryCyclesRemaining: throttleState.recoveryCyclesRemaining || 0,
    recoveryCycleCounter: throttleState.recoveryCycleCounter || 0,
    batchDelayMs: throttleState.batchDelayMs,
    pauseDiscovery: throttleState.pauseDiscovery,
    lastCooldownStartedAt: rateLimitState.lastCooldownStartedAt,
    lastRecoveryStartedAt: rateLimitState.lastRecoveryStartedAt,
  };
}

function resetRateLimitState() {
  rateLimitState.consecutive429s = 0;
  rateLimitState.backoffUntil = 0;
  rateLimitState.last429At = null;
  rateLimitState.lastBackoffMs = 0;
  rateLimitState.lastRetryAfterMs = null;
  rateLimitState.lastContext = null;
  rateLimitState.recoveryPhaseIndex = -1;
  rateLimitState.recoveryCyclesRemaining = 0;
  rateLimitState.recoveryCycleCounter = 0;
  rateLimitState.lastCooldownStartedAt = null;
  rateLimitState.lastRecoveryStartedAt = null;
}

function resolveBatchOptions(delayOrOptions = DEFAULT_BATCH_DELAY_MS) {
  const options = typeof delayOrOptions === 'object' && delayOrOptions !== null
    ? { ...delayOrOptions }
    : {};
  const rawDelayMs = typeof delayOrOptions === 'number'
    ? delayOrOptions
    : options.delayMs;
  const delayMs = Number.isFinite(Number(rawDelayMs))
    ? Math.max(0, Math.round(Number(rawDelayMs)))
    : DEFAULT_BATCH_DELAY_MS;

  delete options.delayMs;

  return { options, delayMs };
}

async function fetchTokenPairsUncached(address, priorityHint) {
  if (isRateLimitBackoffActive()) {
    setCacheEntry(address, null, getRateLimitCooldownCacheTtlMs());
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const res = await fetch(`${DEXSCREENER_BASE}/latest/dex/tokens/${address}`, {
      signal: controller.signal,
    });

    if (res.status === 429) {
      const rateLimitResult = noteRateLimit(res, `token ${address}`);
      setCacheEntry(address, null, Math.max(ERROR_COOLDOWN_MS, rateLimitResult.backoffMs || 0));
      return null;
    }

    if (!res.ok) {
      console.error(`[DexScreener] Error ${res.status} for ${address}`);
      setCacheEntry(address, null, ERROR_COOLDOWN_MS);
      return null;
    }

    const data = await res.json();
    noteSuccessfulResponse();
    setCacheEntry(address, data, getTokenCacheTtl(priorityHint));
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(`[DexScreener] Timeout for ${address}`);
    } else {
      console.error(`[DexScreener] Fetch error for ${address}:`, err.message);
    }
    setCacheEntry(address, null, ERROR_COOLDOWN_MS);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeAddress(address) {
  return String(address || '').trim();
}

function buildNormalizedPairsPayload(pairs) {
  return { pairs: Array.isArray(pairs) ? pairs : [] };
}

function getRequestedAddressSet(addresses) {
  return new Set((addresses || []).map((address) => normalizeAddress(address)).filter(Boolean));
}

function groupPairsByAddress(pairs, requestedAddresses) {
  const addressSet = getRequestedAddressSet(requestedAddresses);
  const grouped = new Map();

  for (const address of addressSet) {
    grouped.set(address, []);
  }

  for (const pair of Array.isArray(pairs) ? pairs : []) {
    const baseAddress = normalizeAddress(pair?.baseToken?.address);
    const quoteAddress = normalizeAddress(pair?.quoteToken?.address);

    if (addressSet.has(baseAddress)) {
      grouped.get(baseAddress).push(pair);
    }
    if (quoteAddress !== baseAddress && addressSet.has(quoteAddress)) {
      grouped.get(quoteAddress).push(pair);
    }
  }

  return grouped;
}

function toFiniteNumberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getSinglePairFromPayload(payload) {
  if (!payload?.pairs || payload.pairs.length !== 1) {
    return null;
  }
  return payload.pairs[0] || null;
}

function isPairOnRequestedChain(pair, chain = 'solana') {
  return String(pair?.chainId || '').trim().toLowerCase() === String(chain || 'solana').trim().toLowerCase();
}

function isPumpfunPair(pair) {
  return String(pair?.dexId || '').trim().toLowerCase() === 'pumpfun';
}

function isPairForRequestedAddress(pair, address) {
  const normalizedAddress = normalizeAddress(address);
  if (!normalizedAddress) {
    return false;
  }

  const baseAddress = normalizeAddress(pair?.baseToken?.address);
  const quoteAddress = normalizeAddress(pair?.quoteToken?.address);
  return baseAddress === normalizedAddress || quoteAddress === normalizedAddress;
}

function isLowConfidencePumpfunPair(pair) {
  const liquidityUsd = toFiniteNumberOrZero(pair?.liquidity?.usd);
  const volume1h = toFiniteNumberOrZero(pair?.volume?.h1);
  const volume6h = toFiniteNumberOrZero(pair?.volume?.h6);
  const marketCap = toFiniteNumberOrZero(pair?.marketCap || pair?.fdv);

  return liquidityUsd <= 1000
    && volume1h <= 0
    && volume6h <= 0
    && marketCap > 0
    && marketCap < 250000;
}

function shouldFallbackSuspiciousBatchPair(address, payload, chain = 'solana') {
  const pair = getSinglePairFromPayload(payload);
  if (!pair) {
    return false;
  }

  if (!isPairOnRequestedChain(pair, chain)) {
    return false;
  }

  if (!isPumpfunPair(pair)) {
    return false;
  }

  if (!isPairForRequestedAddress(pair, address)) {
    return false;
  }

  return isLowConfidencePumpfunPair(pair);
}

async function fetchTokenPairsBatchUncached(addresses, options = {}) {
  const normalizedAddresses = [...new Set((addresses || []).map((address) => normalizeAddress(address)).filter(Boolean))];
  const chain = String(options.chain || 'solana').trim() || 'solana';
  const priorityByAddress = options.priorityByAddress instanceof Map
    ? options.priorityByAddress
    : new Map(Object.entries(options.priorityByAddress || {}));
  const results = new Map();

  for (let index = 0; index < normalizedAddresses.length; index += TOKEN_BATCH_LIMIT) {
    const chunk = normalizedAddresses.slice(index, index + TOKEN_BATCH_LIMIT);
    if (chunk.length === 0) continue;

    if (isRateLimitBackoffActive()) {
      const ttlMs = getRateLimitCooldownCacheTtlMs();
      for (const address of chunk) {
        setCacheEntry(address, null, ttlMs);
        results.set(address, null);
      }
      continue;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
      const joinedAddresses = chunk.join(',');
      const res = await fetch(`${DEXSCREENER_BASE}/tokens/v1/${encodeURIComponent(chain)}/${joinedAddresses}`, {
        signal: controller.signal,
      });

      if (res.status === 429) {
        const rateLimitResult = noteRateLimit(res, `batch ${chunk.length} tokens on ${chain}`);
        const ttlMs = Math.max(ERROR_COOLDOWN_MS, rateLimitResult.backoffMs || 0);
        for (const address of chunk) {
          setCacheEntry(address, null, ttlMs);
          results.set(address, null);
        }
        continue;
      }

      if (!res.ok) {
        console.error(`[DexScreener] Error ${res.status} for batch ${chunk.length} tokens on ${chain}`);
        for (const address of chunk) {
          setCacheEntry(address, null, ERROR_COOLDOWN_MS);
          results.set(address, null);
        }
        continue;
      }

      const pairs = await res.json();
      noteSuccessfulResponse();
      const groupedPairs = groupPairsByAddress(pairs, chunk);
      const fallbackAddresses = [];

      for (const address of chunk) {
        const payload = buildNormalizedPairsPayload(groupedPairs.get(address) || []);
        if (shouldFallbackSuspiciousBatchPair(address, payload, chain)) {
          fallbackAddresses.push(address);
          continue;
        }
        const data = payload.pairs.length > 0 ? payload : null;
        const ttlMs = data
          ? getTokenCacheTtl(priorityByAddress.get(address))
          : ERROR_COOLDOWN_MS;
        setCacheEntry(address, data, ttlMs);
        results.set(address, data);
      }

      if (fallbackAddresses.length > 0) {
        await Promise.all(fallbackAddresses.map(async (address) => {
          const fallbackData = await fetchTokenPairsUncached(address, priorityByAddress.get(address));
          results.set(address, fallbackData);
        }));
      }
    } catch (err) {
      const label = err.name === 'AbortError' ? 'Timeout' : 'Fetch error';
      console.error(`[DexScreener] ${label} for batch ${chunk.length} tokens:`, err.message);
      for (const address of chunk) {
        setCacheEntry(address, null, ERROR_COOLDOWN_MS);
        results.set(address, null);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return results;
}

function getEndpointCacheEntry(key) {
  const entry = endpointCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    endpointCache.delete(key);
    return null;
  }
  return entry;
}

function setEndpointCacheEntry(key, data, ttlMs) {
  endpointCache.set(key, {
    data,
    expiresAt: Date.now() + ttlMs,
  });
  pruneCacheMap(endpointCache, MAX_ENDPOINT_CACHE_ENTRIES);
}

async function fetchEndpointJsonUncached(path) {
  if (isRateLimitBackoffActive()) {
    setEndpointCacheEntry(path, null, getRateLimitCooldownCacheTtlMs());
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const res = await fetch(`${DEXSCREENER_BASE}${path}`, {
      signal: controller.signal,
    });

    if (res.status === 429) {
      const rateLimitResult = noteRateLimit(res, path);
      setEndpointCacheEntry(path, null, Math.max(ERROR_COOLDOWN_MS, rateLimitResult.backoffMs || 0));
      return null;
    }

    if (!res.ok) {
      console.error(`[DexScreener] Error ${res.status} for ${path}`);
      setEndpointCacheEntry(path, null, ERROR_COOLDOWN_MS);
      return null;
    }

    const data = await res.json();
    noteSuccessfulResponse();
    setEndpointCacheEntry(path, data, DEFAULT_CACHE_TTL_MS);
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(`[DexScreener] Timeout for ${path}`);
    } else {
      console.error(`[DexScreener] Fetch error for ${path}:`, err.message);
    }
    setEndpointCacheEntry(path, null, ERROR_COOLDOWN_MS);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function getEndpointJson(path) {
  const key = String(path || '').trim();
  if (!key) return null;

  pruneCacheMap(endpointCache, MAX_ENDPOINT_CACHE_ENTRIES);
  const cached = getEndpointCacheEntry(key);
  if (cached) return cached.data;

  const inFlight = endpointInFlightRequests.get(key);
  if (inFlight) return inFlight;

  const request = fetchEndpointJsonUncached(key)
    .finally(() => {
      endpointInFlightRequests.delete(key);
    });

  endpointInFlightRequests.set(key, request);
  return request;
}

async function getTokenPairs(address, options = {}) {
  const addr = String(address || '').trim();
  if (!addr) return null;

  pruneCacheMap(tokenCache, MAX_TOKEN_CACHE_ENTRIES);
  const cached = getCacheEntry(addr);
  if (cached) return cached.data;

  const inFlight = inFlightRequests.get(addr);
  if (inFlight) return inFlight;

  const request = fetchTokenPairsUncached(addr, options.priority)
    .finally(() => {
      inFlightRequests.delete(addr);
    });

  inFlightRequests.set(addr, request);
  return request;
}

async function batchGetTokens(addresses, delayOrOptions = DEFAULT_BATCH_DELAY_MS) {
  const { options, delayMs } = resolveBatchOptions(delayOrOptions);
  const normalizedAddresses = [...new Set((addresses || []).map((address) => normalizeAddress(address)).filter(Boolean))];
  const results = new Map();
  const missing = [];

  pruneCacheMap(tokenCache, MAX_TOKEN_CACHE_ENTRIES);
  for (const address of normalizedAddresses) {
    const cached = getCacheEntry(address);
    if (cached) {
      results.set(address, cached.data);
    } else {
      missing.push(address);
    }
  }

  if (missing.length > 0) {
    const fetched = await fetchTokenPairsBatchUncached(missing, options);
    for (const [address, data] of fetched.entries()) {
      results.set(address, data);
    }
  }

  if (missing.length > 0 && delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return results;
}

function getBestPair(data, chain = 'solana') {
  if (!data?.pairs?.length) return null;

  const chainPairs = data.pairs.filter(p => p.chainId === chain);
  if (!chainPairs.length) return null;

  return chainPairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
}

function clearCache(address = null) {
  if (address) {
    tokenCache.delete(String(address).trim());
    inFlightRequests.delete(String(address).trim());
    return;
  }
  tokenCache.clear();
  inFlightRequests.clear();
  endpointCache.clear();
  endpointInFlightRequests.clear();
}

function getCacheStats() {
  pruneCacheMap(tokenCache, MAX_TOKEN_CACHE_ENTRIES);
  pruneCacheMap(endpointCache, MAX_ENDPOINT_CACHE_ENTRIES);

  return {
    tokenCacheEntries: tokenCache.size,
    tokenCacheLimit: MAX_TOKEN_CACHE_ENTRIES,
    endpointCacheEntries: endpointCache.size,
    endpointCacheLimit: MAX_ENDPOINT_CACHE_ENTRIES,
    inFlightTokenRequests: inFlightRequests.size,
    inFlightEndpointRequests: endpointInFlightRequests.size,
    rateLimit: getRateLimitState(),
  };
}

function getLatestTokenProfiles() {
  return getEndpointJson('/token-profiles/latest/v1');
}

function getTopTokenBoosts() {
  return getEndpointJson('/token-boosts/top/v1');
}

function getLatestTokenBoosts() {
  return getEndpointJson('/token-boosts/latest/v1');
}

module.exports = {
  getTokenPairs,
  batchGetTokens,
  getBestPair,
  getLatestTokenProfiles,
  getTopTokenBoosts,
  getLatestTokenBoosts,
  completeRecoveryCycle,
  getThrottleState,
  isRateLimitBackoffActive,
  getRateLimitState,
  clearCache,
  getCacheStats,
  __private: {
    addRateLimitJitter,
    completeRecoveryCycle,
    computeRateLimitBackoffMs,
    fetchTokenPairsBatchUncached,
    getThrottleState,
    isRecoveryActive,
    noteRateLimit,
    noteSuccessfulResponse,
    parseRetryAfterMs,
    resetRateLimitState,
    resolveBatchOptions,
    shouldFallbackSuspiciousBatchPair,
  },
};
