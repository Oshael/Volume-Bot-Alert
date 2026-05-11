const CMC_QUOTES_LATEST_URL = 'https://pro-api.coinmarketcap.com/v3/cryptocurrency/quotes/latest';
const CMC_SOLANA_ID = '5426';
const DEFAULT_CONVERT = 'USD';
const DEFAULT_POLL_INTERVAL_MS = 264500;
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 1000;
const DEFAULT_MIN_BACKOFF_MS = 60 * 1000;
const DEFAULT_MAX_BACKOFF_MS = 30 * 60 * 1000;

class SolUsdPriceError extends Error {
  constructor(message, code = 'sol_usd_price_error') {
    super(message);
    this.name = 'SolUsdPriceError';
    this.code = code;
  }
}

function toFiniteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parsePositiveInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(min, Math.min(parsed, max));
}

function normalizeString(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function normalizeConvert(value) {
  return normalizeString(value, DEFAULT_CONVERT).toUpperCase();
}

function clampDelayMs(value, minMs = 1000, maxMs = DEFAULT_MAX_BACKOFF_MS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return minMs;
  }
  return Math.max(minMs, Math.min(Math.round(parsed), maxMs));
}

function parseRetryAfterMs(value, now = Date.now()) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function computeBackoffMs(retryAfterMs, consecutiveErrors, options = {}) {
  const minBackoffMs = options.minBackoffMs || DEFAULT_MIN_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs || DEFAULT_MAX_BACKOFF_MS;
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return clampDelayMs(retryAfterMs, minBackoffMs, maxBackoffMs);
  }

  const exponent = Math.max(0, Math.min(6, Number(consecutiveErrors || 1) - 1));
  return clampDelayMs(minBackoffMs * (2 ** exponent), minBackoffMs, maxBackoffMs);
}

function resolveOptions(options = {}) {
  const env = options.env || process.env;
  return {
    provider: normalizeString(options.provider ?? env.SOL_PRICE_PROVIDER, 'coinmarketcap').toLowerCase(),
    apiKey: normalizeString(options.apiKey ?? env.COINMARKETCAP_API_KEY),
    assetId: normalizeString(options.assetId ?? env.SOL_CMC_ASSET_ID, CMC_SOLANA_ID),
    convert: normalizeConvert(options.convert ?? env.SOL_PRICE_CONVERT),
    pollIntervalMs: parsePositiveInteger(
      options.pollIntervalMs ?? env.SOL_PRICE_POLL_INTERVAL_MS,
      DEFAULT_POLL_INTERVAL_MS,
      30 * 1000,
      60 * 60 * 1000
    ),
    staleAfterMs: parsePositiveInteger(
      options.staleAfterMs ?? env.SOL_PRICE_STALE_AFTER_MS,
      DEFAULT_STALE_AFTER_MS,
      30 * 1000,
      60 * 60 * 1000
    ),
    requestTimeoutMs: parsePositiveInteger(
      options.requestTimeoutMs ?? env.SOL_PRICE_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      1000,
      60 * 1000
    ),
    minBackoffMs: parsePositiveInteger(
      options.minBackoffMs ?? env.SOL_PRICE_MIN_BACKOFF_MS,
      DEFAULT_MIN_BACKOFF_MS,
      1000,
      60 * 60 * 1000
    ),
    maxBackoffMs: parsePositiveInteger(
      options.maxBackoffMs ?? env.SOL_PRICE_MAX_BACKOFF_MS,
      DEFAULT_MAX_BACKOFF_MS,
      1000,
      60 * 60 * 1000
    ),
    fetchImpl: options.fetchImpl || global.fetch,
    now: options.now || (() => Date.now()),
    setTimeoutImpl: options.setTimeoutImpl || setTimeout,
    clearTimeoutImpl: options.clearTimeoutImpl || clearTimeout,
    logger: options.logger || console,
  };
}

function buildCoinMarketCapUrl(options) {
  const url = new URL(CMC_QUOTES_LATEST_URL);
  url.searchParams.set('id', options.assetId);
  url.searchParams.set('convert', options.convert);
  return url.toString();
}

function selectQuoteEntry(data, assetId) {
  if (Array.isArray(data)) {
    return data.find((entry) => String(entry?.id || '') === String(assetId))
      || data.find((entry) => String(entry?.symbol || '').toUpperCase() === 'SOL')
      || (data.length === 1 ? data[0] : null);
  }

  if (!data || typeof data !== 'object') {
    return null;
  }

  return data[assetId]
    || data.SOL
    || Object.values(data).find((entry) => String(entry?.id || '') === String(assetId))
    || Object.values(data).find((entry) => String(entry?.symbol || '').toUpperCase() === 'SOL')
    || null;
}

function selectQuoteCurrency(quote, convert) {
  if (!quote || typeof quote !== 'object') {
    return null;
  }

  if (Array.isArray(quote)) {
    return quote.find((entry) => String(entry?.symbol || entry?.name || '').toUpperCase() === convert)
      || (quote.length === 1 ? quote[0] : null);
  }

  return quote[convert] || quote[convert.toLowerCase()] || null;
}

function assertCoinMarketCapStatus(payload) {
  const statusCode = toFiniteNumber(payload?.status?.error_code, 0);
  if (statusCode !== 0) {
    throw new SolUsdPriceError(
      payload?.status?.error_message || `CoinMarketCap status error ${statusCode}`,
      'coinmarketcap_status_error'
    );
  }
}

function extractQuotePrice(entry, quote) {
  return toFiniteNumber(entry?.price, null) ?? toFiniteNumber(quote?.price, null);
}

function extractQuoteUpdatedAt(payload, entry, quote) {
  return entry?.last_updated
    || quote?.last_updated
    || quote?.timestamp
    || payload?.status?.timestamp
    || null;
}

function parseCoinMarketCapSolQuote(payload, options = {}) {
  const assetId = normalizeString(options.assetId, CMC_SOLANA_ID);
  const convert = normalizeConvert(options.convert);
  assertCoinMarketCapStatus(payload);

  const entry = selectQuoteEntry(payload?.data, assetId);
  const quote = selectQuoteCurrency(entry?.quote, convert);
  const priceUsd = extractQuotePrice(entry, quote);
  if (!(priceUsd > 0)) {
    throw new SolUsdPriceError('CoinMarketCap response did not include a valid SOL/USD price', 'price_unavailable');
  }

  return {
    provider: 'coinmarketcap',
    assetId,
    convert,
    priceUsd,
    lastUpdatedAt: extractQuoteUpdatedAt(payload, entry, quote),
  };
}

function createSolUsdPriceService(options = {}) {
  const resolved = resolveOptions(options);
  let running = false;
  let fetchInFlight = false;
  let fetchTimer = null;
  let nextFetchAt = 0;
  let priceUsd = null;
  let lastUpdatedAt = null;
  let lastFetchAt = null;
  let lastError = null;
  let consecutiveErrors = 0;

  function getAgeSeconds(now = resolved.now()) {
    const updatedMs = Date.parse(String(lastUpdatedAt || ''));
    return Number.isFinite(updatedMs) ? Math.max(0, Math.round((now - updatedMs) / 1000)) : null;
  }

  function isStale(now = resolved.now()) {
    const ageSeconds = getAgeSeconds(now);
    return !(priceUsd > 0) || ageSeconds == null || (ageSeconds * 1000) > resolved.staleAfterMs;
  }

  function getStatus() {
    const now = resolved.now();
    return {
      provider: resolved.provider,
      configured: Boolean(resolved.apiKey),
      running,
      fetchInFlight,
      priceUsd,
      lastUpdatedAt,
      lastFetchAt,
      ageSeconds: getAgeSeconds(now),
      stale: isStale(now),
      lastError,
      consecutiveErrors,
      nextFetchAt: nextFetchAt ? new Date(nextFetchAt).toISOString() : null,
      nextFetchInSeconds: nextFetchAt ? Math.max(0, Math.round((nextFetchAt - now) / 1000)) : null,
    };
  }

  function scheduleNextFetch(delayMs = resolved.pollIntervalMs) {
    if (!running) return;
    const safeDelayMs = clampDelayMs(delayMs, 1000, resolved.maxBackoffMs);
    if (fetchTimer) {
      resolved.clearTimeoutImpl(fetchTimer);
      fetchTimer = null;
    }
    nextFetchAt = resolved.now() + safeDelayMs;
    fetchTimer = resolved.setTimeoutImpl(() => {
      fetchTimer = null;
      void fetchOnce();
    }, safeDelayMs);
  }

  function markRetryableError(code, delayMs = null) {
    consecutiveErrors += 1;
    lastError = code;
    scheduleNextFetch(delayMs ?? computeBackoffMs(null, consecutiveErrors, resolved));
  }

  function markFetchAttempt() {
    lastFetchAt = new Date(resolved.now()).toISOString();
  }

  function validateFetchPrerequisites() {
    if (fetchInFlight) return getStatus();
    if (resolved.provider !== 'coinmarketcap') {
      lastError = 'unsupported_provider';
      scheduleNextFetch(resolved.pollIntervalMs);
      return getStatus();
    }
    if (!resolved.apiKey) {
      lastError = 'missing_api_key';
      scheduleNextFetch(resolved.pollIntervalMs);
      return getStatus();
    }
    if (typeof resolved.fetchImpl !== 'function') {
      lastError = 'missing_fetch';
      scheduleNextFetch(resolved.pollIntervalMs);
      return getStatus();
    }
    return null;
  }

  function buildFetchControl() {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller
      ? resolved.setTimeoutImpl(() => controller.abort(), resolved.requestTimeoutMs)
      : null;
    return { controller, timeout };
  }

  function buildFetchOptions(controller) {
    return {
      signal: controller?.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'VolumeAlertBot/1.0',
        'X-CMC_PRO_API_KEY': resolved.apiKey,
      },
    };
  }

  function handleRateLimitResponse(response) {
    const retryAfterMs = parseRetryAfterMs(response.headers?.get?.('retry-after'), resolved.now());
    markRetryableError('rate_limited', computeBackoffMs(retryAfterMs, consecutiveErrors + 1, resolved));
    return getStatus();
  }

  function handleHttpErrorResponse(response) {
    markRetryableError(`http_${response.status}`);
    return getStatus();
  }

  function applyQuote(quote) {
    priceUsd = quote.priceUsd;
    lastUpdatedAt = quote.lastUpdatedAt || lastFetchAt;
    consecutiveErrors = 0;
    lastError = null;
    scheduleNextFetch(resolved.pollIntervalMs);
    return getStatus();
  }

  function handleFetchException(err) {
    markFetchAttempt();
    const code = err?.name === 'AbortError' ? 'timeout' : (err?.code || 'fetch_error');
    markRetryableError(code);
    resolved.logger?.warn?.(`[SOL/USD] CoinMarketCap fetch failed: ${err?.message || err}`);
    return getStatus();
  }

  async function fetchOnce() {
    const invalidStatus = validateFetchPrerequisites();
    if (invalidStatus) return invalidStatus;

    fetchInFlight = true;
    const { controller, timeout } = buildFetchControl();
    let result = null;

    try {
      const response = await resolved.fetchImpl(buildCoinMarketCapUrl(resolved), buildFetchOptions(controller));
      markFetchAttempt();
      if (response.status === 429) {
        result = handleRateLimitResponse(response);
        return result;
      }
      if (!response.ok) {
        result = handleHttpErrorResponse(response);
        return result;
      }

      result = applyQuote(parseCoinMarketCapSolQuote(await response.json(), resolved));
      return result;
    } catch (err) {
      result = handleFetchException(err);
      return result;
    } finally {
      if (timeout) {
        resolved.clearTimeoutImpl(timeout);
      }
      fetchInFlight = false;
      if (result) {
        result.fetchInFlight = false;
      }
    }
  }

  function start() {
    if (running) return Promise.resolve(getStatus());
    running = true;
    return fetchOnce();
  }

  function stop() {
    running = false;
    if (fetchTimer) {
      resolved.clearTimeoutImpl(fetchTimer);
      fetchTimer = null;
    }
    nextFetchAt = 0;
  }

  function getFreshQuote() {
    const status = getStatus();
    if (!(status.priceUsd > 0) || status.stale) {
      throw new SolUsdPriceError('Fresh SOL/USD price is unavailable', 'fresh_price_unavailable');
    }
    return {
      provider: status.provider,
      priceUsd: status.priceUsd,
      lastUpdatedAt: status.lastUpdatedAt,
      ageSeconds: status.ageSeconds,
    };
  }

  return {
    fetchOnce,
    getFreshQuote,
    getStatus,
    start,
    stop,
  };
}

const defaultService = createSolUsdPriceService();

module.exports = {
  CMC_SOLANA_ID,
  DEFAULT_CONVERT,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STALE_AFTER_MS,
  SolUsdPriceError,
  createSolUsdPriceService,
  fetchOnce: defaultService.fetchOnce,
  getFreshQuote: defaultService.getFreshQuote,
  getStatus: defaultService.getStatus,
  start: defaultService.start,
  stop: defaultService.stop,
  __private: {
    buildCoinMarketCapUrl,
    computeBackoffMs,
    parseCoinMarketCapSolQuote,
    parsePositiveInteger,
    parseRetryAfterMs,
    resolveOptions,
  },
};
