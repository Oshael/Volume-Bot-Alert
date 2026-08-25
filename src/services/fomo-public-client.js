'use strict';

const DEFAULT_BASE_URL = 'https://prod-api.fomo.family';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SUPPORTED_CHAINS = '1,56,143,4663,8453,1399811149';
const LEADERBOARD_PERIODS = new Set(['overall', '24h', '7d', '30d']);

class FomoPublicHttpError extends Error {
  constructor(status) {
    super(`Fomo public API HTTP ${status}`);
    this.name = 'FomoPublicHttpError';
    this.code = status === 429 ? 'FOMO_RATE_LIMIT' : 'FOMO_HTTP';
    this.status = status;
  }
}

function boundedInteger(value, fallback, max = 100) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function required(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function createFomoPublicClient(options = {}) {
  const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 60_000);
  const supportedChains = String(options.supportedChains || DEFAULT_SUPPORTED_CHAINS);

  async function request(path, query = {}) {
    const url = new URL(path, `${baseUrl}/`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json', 'x-supported-chains': supportedChains },
        signal: controller.signal,
      });
    } catch (error) {
      const safe = new Error(error?.name === 'AbortError' ? 'Fomo public API timed out' : 'Fomo public API request failed');
      safe.code = error?.name === 'AbortError' ? 'FOMO_TIMEOUT' : 'FOMO_NETWORK';
      throw safe;
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new FomoPublicHttpError(response.status);
    const responseText = await response.text();
    try {
      return { body: responseText ? JSON.parse(responseText) : null, status: response.status };
    } catch (_error) {
      const error = new Error('Fomo public API returned invalid JSON');
      error.code = 'FOMO_INVALID_JSON';
      throw error;
    }
  }

  return {
    getLeaderboard(period = 'overall', options = {}) {
      const normalized = String(period).toLowerCase();
      if (!LEADERBOARD_PERIODS.has(normalized)) throw new TypeError('Fomo leaderboard period must be overall, 24h, 7d or 30d');
      const path = normalized === 'overall' ? '/v2/leaderboard' : `/v2/leaderboard/${normalized}`;
      return request(path, { limit: boundedInteger(options.limit, 100) });
    },
    getTradingActivity: (options = {}) => request('/feed/tradingActivity', {
      limit: boundedInteger(options.limit, 50),
      threshold: options.threshold ?? 1000,
    }),
    getTrade: (tradeId) => request(`/trades/${encodeURIComponent(required(tradeId, 'Fomo trade ID'))}`),
  };
}

module.exports = { FomoPublicHttpError, createFomoPublicClient };
