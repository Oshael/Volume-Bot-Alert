const DEMO_API_BASE_URL = 'https://api.coingecko.com/api/v3';
const PRO_API_BASE_URL = 'https://pro-api.coingecko.com/api/v3';
const DEFAULT_NETWORK = 'solana';
const DEFAULT_TIMEFRAME = 'minute';
const DEFAULT_AGGREGATE = 5;
const DEFAULT_LIMIT = 1000;
const DEFAULT_DAYS = 31;
const DEFAULT_DELAY_MS = 800;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

class CoinGeckoOnchainError extends Error {
  constructor(message, code = 'coingecko_onchain_error', details = {}) {
    super(message);
    this.name = 'CoinGeckoOnchainError';
    this.code = code;
    this.details = details;
  }
}

function normalizeString(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function parsePositiveInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

function parseBoundaryTimestampMs(value, optionName, boundary) {
  const raw = normalizeString(value);
  if (!raw) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? `${raw}T${boundary === 'end' ? '23:59:59.999' : '00:00:00.000'}Z`
    : raw;
  const timestampMs = Date.parse(normalized);
  if (!Number.isFinite(timestampMs)) {
    throw new CoinGeckoOnchainError(
      `${optionName} must be a valid ISO date/time`,
      'invalid_time_range',
      { optionName, value: raw }
    );
  }
  return timestampMs;
}

function resolveRequestedWindow(options, optionsInput = {}) {
  const fromMs = parseBoundaryTimestampMs(
    optionsInput.from ?? optionsInput.fromTimestamp,
    '--from',
    'start'
  );
  const toMs = parseBoundaryTimestampMs(
    optionsInput.to ?? optionsInput.toTimestamp,
    '--to',
    'end'
  );
  const defaultToMs = options.now();
  const maxMs = toMs ?? defaultToMs;
  const minMs = fromMs ?? (maxMs - (options.days * 24 * 60 * 60 * 1000));
  if (minMs > maxMs) {
    throw new CoinGeckoOnchainError(
      '--from must be earlier than or equal to --to',
      'invalid_time_range',
      { from: optionsInput.from ?? optionsInput.fromTimestamp, to: optionsInput.to ?? optionsInput.toTimestamp }
    );
  }
  return {
    minTimestamp: Math.floor(minMs / 1000),
    maxTimestamp: Math.floor(maxMs / 1000),
    from: new Date(minMs).toISOString(),
    to: new Date(maxMs).toISOString(),
    exact: fromMs != null || toMs != null,
  };
}

function sleep(ms, setTimeoutImpl = setTimeout) {
  const delayMs = Math.max(0, Math.trunc(Number(ms) || 0));
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeoutImpl(resolve, delayMs));
}

function parseRetryAfterMs(value, now = Date.now()) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const timestampMs = Date.parse(raw);
  return Number.isFinite(timestampMs) ? Math.max(0, timestampMs - now) : null;
}

function resolveOptions(options = {}) {
  const env = options.env || process.env;
  const plan = normalizeString(options.plan ?? env.COINGECKO_PLAN, 'demo').toLowerCase();
  const isPro = plan === 'pro';
  const apiKey = normalizeString(
    options.apiKey
      ?? env.COINGECKO_DEMO_API_KEY
      ?? env.COINGECKO_API_KEY
  );

  return {
    plan: isPro ? 'pro' : 'demo',
    apiBaseUrl: normalizeString(
      options.apiBaseUrl ?? env.COINGECKO_API_BASE_URL,
      isPro ? PRO_API_BASE_URL : DEMO_API_BASE_URL
    ).replace(/\/+$/, ''),
    apiKey,
    apiKeyHeader: isPro ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key',
    network: normalizeString(options.network ?? env.COINGECKO_ONCHAIN_NETWORK, DEFAULT_NETWORK),
    timeframe: normalizeString(options.timeframe, DEFAULT_TIMEFRAME).toLowerCase(),
    aggregate: parsePositiveInteger(options.aggregate, DEFAULT_AGGREGATE, 1, 60),
    limit: parsePositiveInteger(options.limit, DEFAULT_LIMIT, 1, DEFAULT_LIMIT),
    days: parsePositiveInteger(options.days, DEFAULT_DAYS, 1, 366),
    delayMs: parsePositiveInteger(options.delayMs ?? env.COINGECKO_REQUEST_DELAY_MS, DEFAULT_DELAY_MS, 0, 60000),
    requestTimeoutMs: parsePositiveInteger(
      options.requestTimeoutMs ?? env.COINGECKO_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      1000,
      60000
    ),
    includeEmptyIntervals: options.includeEmptyIntervals !== false,
    currency: normalizeString(options.currency, 'usd').toLowerCase(),
    token: normalizeString(options.token, 'base').toLowerCase(),
    fetchImpl: options.fetchImpl || global.fetch,
    setTimeoutImpl: options.setTimeoutImpl || setTimeout,
    now: options.now || (() => Date.now()),
    logger: options.logger || console,
  };
}

function buildOhlcvUrl(options, poolAddress, beforeTimestamp = null) {
  const url = new URL(
    `${options.apiBaseUrl}/onchain/networks/${encodeURIComponent(options.network)}`
      + `/pools/${encodeURIComponent(poolAddress)}/ohlcv/${encodeURIComponent(options.timeframe)}`
  );
  url.searchParams.set('aggregate', String(options.aggregate));
  url.searchParams.set('limit', String(options.limit));
  url.searchParams.set('currency', options.currency);
  url.searchParams.set('token', options.token);
  url.searchParams.set('include_empty_intervals', options.includeEmptyIntervals ? 'true' : 'false');
  if (beforeTimestamp != null) {
    url.searchParams.set('before_timestamp', String(beforeTimestamp));
  }
  return url.toString();
}

function toFiniteNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeOhlcvItem(item) {
  if (!Array.isArray(item) || item.length < 6) return null;
  const timestamp = Math.trunc(toFiniteNumber(item[0], 0));
  const open = toFiniteNumber(item[1]);
  const high = toFiniteNumber(item[2]);
  const low = toFiniteNumber(item[3]);
  const close = toFiniteNumber(item[4]);
  const volume = toFiniteNumber(item[5], 0);
  if (!(timestamp > 0) || open == null || high == null || low == null || close == null) {
    return null;
  }
  return {
    timestamp,
    bucketTs: new Date(timestamp * 1000).toISOString(),
    open,
    high,
    low,
    close,
    volume,
  };
}

function normalizeOhlcvList(list, minTimestamp = 0, maxTimestamp = Number.MAX_SAFE_INTEGER) {
  const byTimestamp = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    const candle = normalizeOhlcvItem(item);
    if (candle && candle.timestamp >= minTimestamp && candle.timestamp <= maxTimestamp) {
      byTimestamp.set(candle.timestamp, candle);
    }
  }
  return Array.from(byTimestamp.values()).sort((left, right) => left.timestamp - right.timestamp);
}

function getNextBeforeTimestamp(candles) {
  if (!Array.isArray(candles) || !candles.length) return null;
  return Math.min(...candles.map((item) => item.timestamp)) - 1;
}

function extractOhlcvList(payload) {
  return payload?.data?.attributes?.ohlcv_list || [];
}

async function requestJson(url, options) {
  if (!options.fetchImpl) {
    throw new CoinGeckoOnchainError('global fetch is not available', 'fetch_unavailable');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs);
  try {
    const response = await options.fetchImpl(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        [options.apiKeyHeader]: options.apiKey,
      },
    });
    if (response.status === 429) {
      throw new CoinGeckoOnchainError('CoinGecko rate limit exceeded', 'rate_limited', {
        retryAfterMs: parseRetryAfterMs(response.headers?.get?.('retry-after')),
        status: response.status,
      });
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new CoinGeckoOnchainError(`CoinGecko request failed with HTTP ${response.status}`, 'http_error', {
        status: response.status,
        body: body.slice(0, 500),
      });
    }
    return response.json();
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new CoinGeckoOnchainError('CoinGecko request timed out', 'timeout');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestOhlcvPage(options, poolAddress, beforeTimestamp) {
  const url = buildOhlcvUrl(options, poolAddress, beforeTimestamp);
  while (true) {
    try {
      return await requestJson(url, options);
    } catch (error) {
      if (error.code !== 'rate_limited' || error.details?.retryAfterMs == null) {
        throw error;
      }
      const waitMs = Math.max(options.delayMs, error.details.retryAfterMs);
      options.logger.warn(`[CoinGecko] 429; waiting ${waitMs}ms before retrying`);
      await sleep(waitMs, options.setTimeoutImpl);
    }
  }
}

async function fetchPoolOhlcv(optionsInput = {}) {
  const options = resolveOptions(optionsInput);
  const poolAddress = normalizeString(optionsInput.poolAddress);
  if (!poolAddress) {
    throw new CoinGeckoOnchainError('poolAddress is required', 'pool_required');
  }
  if (!options.apiKey) {
    throw new CoinGeckoOnchainError('COINGECKO_DEMO_API_KEY or COINGECKO_API_KEY is required', 'api_key_required');
  }

  const requestedWindow = resolveRequestedWindow(options, optionsInput);
  const byTimestamp = new Map();
  let beforeTimestamp = optionsInput.beforeTimestamp
    ? parsePositiveInteger(optionsInput.beforeTimestamp, 0)
    : requestedWindow.maxTimestamp + (requestedWindow.exact ? 1 : 60);
  let calls = 0;
  let lastMeta = null;

  while (beforeTimestamp > requestedWindow.minTimestamp) {
    const payload = await requestOhlcvPage(options, poolAddress, beforeTimestamp);
    calls += 1;
    lastMeta = payload?.meta || lastMeta;
    const rawPage = normalizeOhlcvList(extractOhlcvList(payload));
    if (!rawPage.length) break;
    const page = rawPage.filter((candle) => (
      candle.timestamp >= requestedWindow.minTimestamp
      && candle.timestamp <= requestedWindow.maxTimestamp
    ));
    for (const candle of page) {
      byTimestamp.set(candle.timestamp, candle);
    }
    const nextBeforeTimestamp = getNextBeforeTimestamp(rawPage);
    if (nextBeforeTimestamp == null || nextBeforeTimestamp >= beforeTimestamp) break;
    beforeTimestamp = nextBeforeTimestamp;
    await sleep(options.delayMs, options.setTimeoutImpl);
  }

  const candles = Array.from(byTimestamp.values()).sort((left, right) => left.timestamp - right.timestamp);
  return {
    poolAddress,
    network: options.network,
    timeframe: options.timeframe,
    aggregate: options.aggregate,
    currency: options.currency,
    token: options.token,
    requestedDays: options.days,
    requestedFrom: requestedWindow.exact ? requestedWindow.from : null,
    requestedTo: requestedWindow.exact ? requestedWindow.to : null,
    calls,
    meta: lastMeta,
    candles,
  };
}

function buildSparklinePayload(result, tokenAddress) {
  const candles = (result.candles || []).map((candle) => ({
    bucketTs: candle.bucketTs,
    pairAddress: result.poolAddress,
    granularityMinutes: result.timeframe === 'minute' ? result.aggregate : null,
    openMcap: candle.open,
    highMcap: candle.high,
    lowMcap: candle.low,
    closeMcap: candle.close,
    openPrice: candle.open,
    highPrice: candle.high,
    lowPrice: candle.low,
    closePrice: candle.close,
    volume: candle.volume,
    sampleCount: 1,
  }));

  return {
    generatedAt: new Date().toISOString(),
    source: 'coingecko-onchain-pool-ohlcv',
    note: 'Price OHLC is duplicated into mcap fields only for current chart-rendering experiments.',
    item: {
      address: tokenAddress,
      pairAddress: result.poolAddress,
      bucketCount: candles.length,
      coverageRatio: 1,
      effectiveHours: candles.length ? ((candles.at(-1).bucketTs && candles[0].bucketTs)
        ? Math.max(0, (Date.parse(candles.at(-1).bucketTs) - Date.parse(candles[0].bucketTs)) / 3600000)
        : 0) : 0,
      granularityMinutes: result.timeframe === 'minute' ? result.aggregate : null,
      firstBucketAt: candles[0]?.bucketTs || null,
      latestBucketAt: candles.at(-1)?.bucketTs || null,
      series: candles.map((candle) => candle.closePrice).filter((value) => Number.isFinite(value)),
      candles,
    },
  };
}

module.exports = {
  CoinGeckoOnchainError,
  fetchPoolOhlcv,
  buildSparklinePayload,
  __private: {
    buildOhlcvUrl,
    getNextBeforeTimestamp,
    normalizeOhlcvList,
    parseRetryAfterMs,
    resolveOptions,
  },
};
