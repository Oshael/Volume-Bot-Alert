const gmgnClient = require('./gmgn-client');

const DEFAULT_INTERVALS = ['1m', '5m'];
const DEFAULT_REQUESTS_PER_WINDOW = 2;
const DEFAULT_REQUEST_WINDOW_MS = 2000;
const DEFAULT_TRENDING_LIMIT = 30;
const DEFAULT_CHAIN = 'sol';
const DEFAULT_BACKOFF_MIN_MS = 5000;
const DEFAULT_BACKOFF_MAX_MS = 60000;
const MAX_INTERVALS_PER_WINDOW = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeIntervals(value) {
  if (Array.isArray(value)) {
    const normalized = value.map((item) => gmgnClient.__private.normalizeInterval(item));
    return [...new Set(normalized)].slice(0, MAX_INTERVALS_PER_WINDOW);
  }
  return DEFAULT_INTERVALS;
}

function resolveSchedulerOptions(options = {}) {
  const requestWindowMs = parsePositiveInteger(
    options.requestWindowMs || process.env.GMGN_REQUEST_WINDOW_MS,
    DEFAULT_REQUEST_WINDOW_MS
  );
  const requestsPerWindow = parsePositiveInteger(
    options.requestsPerWindow || process.env.GMGN_REQUESTS_PER_WINDOW,
    DEFAULT_REQUESTS_PER_WINDOW
  );

  return {
    chain: gmgnClient.__private.normalizeChain(options.chain || process.env.GMGN_CHAIN || DEFAULT_CHAIN),
    intervals: normalizeIntervals(options.intervals),
    requestsPerWindow,
    requestWindowMs,
    trendingLimit: gmgnClient.__private.normalizeLimit(
      options.trendingLimit || process.env.GMGN_TRENDING_LIMIT || DEFAULT_TRENDING_LIMIT
    ),
    backoffMinMs: parsePositiveInteger(options.backoffMinMs || process.env.GMGN_BACKOFF_MIN_MS, DEFAULT_BACKOFF_MIN_MS),
    backoffMaxMs: parsePositiveInteger(options.backoffMaxMs || process.env.GMGN_BACKOFF_MAX_MS, DEFAULT_BACKOFF_MAX_MS),
    now: options.now || (() => Date.now()),
    sleepImpl: options.sleepImpl || sleep,
    client: options.client || gmgnClient.createGmgnClient(options.clientOptions || {}),
  };
}

function buildTrendingRequestPlan(options = {}) {
  const resolved = resolveSchedulerOptions({ ...options, client: options.client || { fetchTrending: async () => [] } });
  const intervals = resolved.intervals.slice(0, resolved.requestsPerWindow);
  const slotMs = Math.floor(resolved.requestWindowMs / Math.max(1, intervals.length));

  return intervals.map((interval, index) => ({
    chain: resolved.chain,
    interval,
    limit: resolved.trendingLimit,
    offsetMs: index * slotMs,
  }));
}

function dedupeTrendingTokens(tokens) {
  const byAddress = new Map();
  for (const token of Array.isArray(tokens) ? tokens : []) {
    const address = String(token?.address || '').trim();
    if (!address) {
      continue;
    }
    byAddress.set(address, mergeTrendingToken(byAddress.get(address), token));
  }
  return [...byAddress.values()];
}

function mergeTrendingToken(existing, token) {
  if (!existing) {
    return attachIntervalMetadata(token);
  }

  const merged = { ...existing };
  const fieldsToFill = [
    'symbol',
    'name',
    'imageUrl',
    'pairAddress',
    'pairUrl',
    'mcap',
    'price',
    'liquidityUsd',
    'tokenCreatedAt',
  ];
  const intervalFields = [
    'vol1m',
    'vol5m',
    'vol1h',
    'vol6h',
    'vol24h',
    'priceChange1m',
    'priceChange5m',
    'priceChange1h',
    'priceChange6h',
    'priceChange24h',
  ];

  for (const field of fieldsToFill) {
    if (merged[field] == null && token[field] != null) {
      merged[field] = token[field];
    }
  }
  for (const field of intervalFields) {
    if (token[field] != null) {
      merged[field] = token[field];
    }
  }

  return attachIntervalMetadata(merged, token);
}

function attachIntervalMetadata(token, nextToken = token) {
  const interval = String(nextToken?.gmgnInterval || '').trim();
  const intervals = new Set(Array.isArray(token.gmgnIntervals) ? token.gmgnIntervals : []);
  if (interval) {
    intervals.add(interval);
  }

  return {
    ...token,
    gmgnIntervals: [...intervals],
  };
}

function calculateBackoffMs(error, options) {
  const resetAt = Number(error?.resetAt);
  if (Number.isFinite(resetAt) && resetAt > 0) {
    const resetMs = (resetAt * 1000) - options.now();
    return Math.max(options.backoffMinMs, Math.min(options.backoffMaxMs, resetMs));
  }
  return options.backoffMinMs;
}

function summarizeError(error) {
  return {
    name: error?.name || 'Error',
    code: error?.code || null,
    message: error?.message || String(error),
  };
}

function createGmgnDiscoveryScheduler(options = {}) {
  const resolved = resolveSchedulerOptions(options);
  let backoffUntil = 0;
  let totalRequests = 0;
  let totalErrors = 0;

  async function runOnce() {
    const now = resolved.now();
    if (backoffUntil > now) {
      return {
        skipped: true,
        reason: 'gmgn-backoff',
        backoffRemainingMs: backoffUntil - now,
        requests: 0,
        tokens: [],
        uniqueTokens: [],
        errors: [],
      };
    }

    const plan = buildTrendingRequestPlan({
      ...resolved,
      client: resolved.client,
      intervals: resolved.intervals,
    });
    const tokens = [];
    const errors = [];
    let rateLimited = false;
    let attemptedRequests = 0;

    let previousOffsetMs = 0;
    for (const request of plan) {
      const waitMs = Math.max(0, request.offsetMs - previousOffsetMs);
      previousOffsetMs = request.offsetMs;
      if (waitMs > 0) {
        await resolved.sleepImpl(waitMs);
      }

      try {
        attemptedRequests += 1;
        totalRequests += 1;
        const result = await resolved.client.fetchTrending(request);
        tokens.push(...result);
      } catch (error) {
        totalErrors += 1;
        errors.push({ request, error: summarizeError(error) });
        if (error instanceof gmgnClient.GmgnRateLimitError || error?.code === 'GMGN_RATE_LIMIT') {
          rateLimited = true;
          const backoffMs = calculateBackoffMs(error, resolved);
          backoffUntil = resolved.now() + backoffMs;
          break;
        }
      }
    }

    return {
      skipped: false,
      rateLimited,
      backoffRemainingMs: Math.max(0, backoffUntil - resolved.now()),
      requests: attemptedRequests,
      tokens,
      uniqueTokens: dedupeTrendingTokens(tokens),
      errors,
    };
  }

  function getStatus() {
    return {
      backoffUntil,
      backoffRemainingMs: Math.max(0, backoffUntil - resolved.now()),
      totalRequests,
      totalErrors,
      requestsPerWindow: resolved.requestsPerWindow,
      requestWindowMs: resolved.requestWindowMs,
      intervals: [...resolved.intervals],
    };
  }

  return {
    runOnce,
    getStatus,
  };
}

module.exports = {
  createGmgnDiscoveryScheduler,
  __private: {
    attachIntervalMetadata,
    buildTrendingRequestPlan,
    calculateBackoffMs,
    dedupeTrendingTokens,
    mergeTrendingToken,
    resolveSchedulerOptions,
  },
};
