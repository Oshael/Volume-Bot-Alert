'use strict';

const DEFAULT_BASE_URL = 'https://frontend-api-v3.pump.fun';
const DEFAULT_TIMEOUT_MS = 10_000;

class PumpCalloutHttpError extends Error {
  constructor(status, details = {}) {
    super(`Pump callout API HTTP ${status}`);
    this.name = 'PumpCalloutHttpError';
    this.code = status === 401 || status === 403 ? 'PUMP_AUTH' : status === 429 ? 'PUMP_RATE_LIMIT' : 'PUMP_HTTP';
    this.status = status;
    this.retryAfterMs = details.retryAfterMs ?? null;
  }
}

function positiveInteger(value, fallback, max = 100) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function retryAfterMs(headers, now = Date.now()) {
  const value = headers?.get?.('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

function rateLimitMetadata(headers) {
  const numberOrNull = (name) => {
    const raw = headers?.get?.(name);
    const value = Number(raw);
    return raw !== null && raw !== undefined && Number.isFinite(value) ? value : null;
  };
  return {
    limit: numberOrNull('x-ratelimit-limit'),
    remaining: numberOrNull('x-ratelimit-remaining'),
    resetAt: numberOrNull('x-ratelimit-reset'),
    retryAfterMs: retryAfterMs(headers),
  };
}

function required(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function createPumpCalloutClient(options = {}) {
  const authTokenProvider = options.authTokenProvider;
  if (authTokenProvider !== undefined && typeof authTokenProvider !== 'function') {
    throw new TypeError('Pump auth token provider must be a function');
  }
  const authToken = authTokenProvider ? null : String(options.authToken || process.env.PUMP_AUTH_TOKEN || '').trim();
  const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 60_000);

  async function request(path, query = {}, requestOptions = {}) {
    const url = new URL(path, `${baseUrl}/`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      const headers = { accept: 'application/json' };
      if (requestOptions.authenticated !== false) {
        let requestToken = authToken;
        if (authTokenProvider) {
          try { requestToken = required(await authTokenProvider(), 'Pump auth token'); } catch (_error) {
            throw Object.assign(new Error('Pump auth token is unavailable'), { code: 'PUMP_AUTH' });
          }
        }
        if (!requestToken) throw Object.assign(new Error('Pump auth token is unavailable'), { code: 'PUMP_AUTH' });
        headers.cookie = `auth_token=${requestToken}`;
      }
      response = await fetchImpl(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.code === 'PUMP_AUTH') throw error;
      const safe = new Error(error?.name === 'AbortError' ? 'Pump callout API timed out' : 'Pump callout API request failed');
      safe.code = error?.name === 'AbortError' ? 'PUMP_TIMEOUT' : 'PUMP_NETWORK';
      throw safe;
    } finally {
      clearTimeout(timer);
    }

    const metadata = rateLimitMetadata(response.headers);
    if (!response.ok) throw new PumpCalloutHttpError(response.status, metadata);
    const text = await response.text();
    try {
      return { body: text ? JSON.parse(text) : null, status: response.status, rateLimit: metadata };
    } catch (_error) {
      const error = new Error('Pump callout API returned invalid JSON');
      error.code = 'PUMP_INVALID_JSON';
      throw error;
    }
  }

  return {
    getMyProfile: () => request('/auth/my-profile'),
    getUserProfile: (userIdentifier) => request(
      `/users/${encodeURIComponent(required(userIdentifier, 'userIdentifier'))}`,
      {}, { authenticated: false }
    ),
    getLeaderboard: ({ limit = 50 } = {}) => request('/callout/leaderboard', {
      limit: positiveInteger(limit, 50),
    }),
    listUserCallouts: (userId, options = {}) => request(`/callout/list/${encodeURIComponent(required(userId, 'userId'))}`, {
      limit: positiveInteger(options.limit, 50),
      sortBy: options.sortBy,
      sortOrder: options.sortOrder,
      pageToken: options.pageToken,
    }),
    getCoinTopCallouts: (mint) => request(`/callout/top/${encodeURIComponent(required(mint, 'mint'))}`),
    getCallout: (calloutId) => request(`/callout/${encodeURIComponent(required(calloutId, 'calloutId'))}`),
    getUserMintCallout: (userId, mint) => request(
      `/callout/user/${encodeURIComponent(required(userId, 'userId'))}/mint/${encodeURIComponent(required(mint, 'mint'))}`
    ),
    listFollowingAlerts: (options = {}) => request('/following-positions/alerts', {
      pageSize: positiveInteger(options.pageSize, 50),
      cursor: options.cursor,
      kinds: Array.isArray(options.kinds) ? options.kinds.join(',') : (options.kinds || 'callout,update,trade'),
      minTradeAmountUsd: options.minTradeAmountUsd ?? 10,
    }),
  };
}

module.exports = {
  PumpCalloutHttpError,
  createPumpCalloutClient,
  rateLimitMetadata,
};
