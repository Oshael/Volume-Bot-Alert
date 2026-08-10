const { normalizeTokenAddress } = require('../utils/token-identity');
const { normalizeText } = require('../utils/url-safety');

const DEFAULT_BASE_URL = 'https://robinhoodchain.blockscout.com/api/v2/tokens/';
const DEFAULT_SUMMARY_TIMEOUT_MS = 8000;
const DEFAULT_PAGE_TIMEOUT_MS = 12000;
const MAX_PAGE_ITEMS = 50;
const MAX_CURSOR_LENGTH = 2048;
const CURSOR_KEYS = new Set(['address_hash', 'items_count', 'token_id', 'value']);
const BURN_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);

class RobinhoodBlockscoutHoldersError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'RobinhoodBlockscoutHoldersError';
    this.code = code;
    this.httpStatus = details.httpStatus ?? null;
    this.retryable = details.retryable === true;
    this.retryAfter = normalizeText(details.retryAfter, 64);
  }
}

function holdersError(message, code = 'invalid_response', details) {
  return new RobinhoodBlockscoutHoldersError(message, code, details);
}

function boundedTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(1000, Math.min(parsed, 30_000)) : fallback;
}

function unsignedIntegerString(value, label, optional = false) {
  if (optional && value == null) return null;
  const normalized = String(value ?? '');
  if (!/^\d+$/.test(normalized)) throw holdersError(`Blockscout ${label} is invalid`);
  return normalized.replace(/^0+(?=\d)/, '');
}

function safeCount(value) {
  if (value == null) return null;
  const normalized = unsignedIntegerString(value, 'holder count');
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) throw holdersError('Blockscout holder count is unsafe');
  return parsed;
}

function payloadAddress(value, label) {
  try {
    return normalizeTokenAddress('robinhood', value);
  } catch (_) {
    throw holdersError(`Blockscout ${label} is invalid`);
  }
}

function observedAt(now) {
  const value = new Date(now());
  if (!Number.isFinite(value.getTime())) throw new TypeError('Holders clock must return a valid time');
  return value.toISOString();
}

function cursorUnsignedInteger(value, label) {
  try {
    return unsignedIntegerString(value, label);
  } catch (_) {
    throw holdersError(`Blockscout ${label} is invalid`, 'invalid_cursor');
  }
}

function cursorAddress(value) {
  try {
    return payloadAddress(value, 'holders cursor address');
  } catch (_) {
    throw holdersError('Blockscout holders cursor address is invalid', 'invalid_cursor');
  }
}

function normalizeCursorParams(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw holdersError('Blockscout holders cursor is invalid', 'invalid_cursor');
  }
  if (Object.keys(input).some((key) => !CURSOR_KEYS.has(key))) {
    throw holdersError('Blockscout holders cursor has unsupported fields', 'invalid_cursor');
  }
  const itemsCount = Number(input.items_count);
  if (!Number.isSafeInteger(itemsCount) || itemsCount < 1 || itemsCount > 10_000_000) {
    throw holdersError('Blockscout holders cursor count is invalid', 'invalid_cursor');
  }
  const normalized = {
    items_count: itemsCount,
    value: cursorUnsignedInteger(input.value, 'holders cursor value'),
  };
  if (input.address_hash != null) {
    normalized.address_hash = cursorAddress(input.address_hash);
  }
  if (input.token_id != null) {
    normalized.token_id = cursorUnsignedInteger(input.token_id, 'holders cursor token id');
  }
  return Object.freeze(normalized);
}

function encodeCursor(input) {
  if (input == null) return null;
  return Buffer.from(JSON.stringify(normalizeCursorParams(input))).toString('base64url');
}

function decodeCursor(input) {
  if (input == null || input === '') return null;
  const raw = String(input);
  if (raw.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw holdersError('Holders cursor is malformed', 'invalid_cursor');
  }
  try {
    return normalizeCursorParams(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch (error) {
    if (error instanceof RobinhoodBlockscoutHoldersError) throw error;
    throw holdersError('Holders cursor is malformed', 'invalid_cursor');
  }
}

function validateHoldersCursor(input) {
  decodeCursor(input);
  return input == null || input === '' ? null : String(input);
}

function normalizeSummary(address, payload, now) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw holdersError('Blockscout holder summary is invalid');
  }
  if (payloadAddress(payload.address_hash, 'token address') !== address) {
    throw holdersError('Blockscout token address mismatch', 'address_mismatch');
  }
  const decimals = /^\d+$/.test(String(payload.decimals ?? '')) ? Number(payload.decimals) : null;
  return Object.freeze({
    address,
    available: true,
    holderCount: safeCount(payload.holders_count),
    totalSupplyRaw: unsignedIntegerString(payload.total_supply, 'total supply', true),
    decimals: Number.isInteger(decimals) && decimals >= 0 && decimals <= 255 ? decimals : null,
    source: 'blockscout',
    observedAt: observedAt(now),
  });
}

function publicLabel(addressPayload) {
  const candidates = [addressPayload.name];
  for (const tag of Array.isArray(addressPayload.public_tags) ? addressPayload.public_tags : []) {
    candidates.push(tag?.display_name, tag?.label);
  }
  for (const tag of Array.isArray(addressPayload.metadata?.tags) ? addressPayload.metadata.tags : []) {
    candidates.push(tag?.name);
  }
  return candidates.map((value) => normalizeText(value, 96)).find(Boolean) || null;
}

function addressType(address, addressPayload, label) {
  if (BURN_ADDRESSES.has(address)) return 'burn';
  if (addressPayload.is_contract !== true) return 'wallet';
  return /(?:^|\b)liquidity pool(?:\b|$)|pool(?:manager)?$/i.test(label || '')
    ? 'pool' : 'contract';
}

function normalizeHolder(item, rank) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw holdersError('Blockscout holder item is invalid');
  }
  const addressPayload = item.address || item.address_hash;
  if (!addressPayload || typeof addressPayload !== 'object') {
    throw holdersError('Blockscout holder address is invalid');
  }
  const address = payloadAddress(addressPayload.hash, 'holder address');
  const label = publicLabel(addressPayload);
  return Object.freeze({
    rank,
    address,
    balanceRaw: unsignedIntegerString(item.value, 'holder balance'),
    addressType: addressType(address, addressPayload, label),
    label,
    isVerifiedContract: addressPayload.is_contract === true && addressPayload.is_verified === true,
  });
}

function normalizePage(address, payload, cursor, now) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.items)
    || payload.items.length > MAX_PAGE_ITEMS) {
    throw holdersError('Blockscout holders page is invalid');
  }
  const startRank = cursor?.items_count || 0;
  const items = payload.items.map((item, index) => normalizeHolder(item, startRank + index + 1));
  const nextCursor = encodeCursor(payload.next_page_params);
  return Object.freeze({
    address,
    items: Object.freeze(items),
    hasMore: nextCursor != null,
    nextCursor,
    source: 'blockscout',
    observedAt: observedAt(now),
  });
}

function createRobinhoodBlockscoutHoldersClient(options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');
  const baseUrl = new URL(String(options.baseUrl || DEFAULT_BASE_URL));
  if (baseUrl.protocol !== 'https:') throw new TypeError('Blockscout holders URL must use HTTPS');
  const summaryTimeoutMs = boundedTimeout(options.summaryTimeoutMs, DEFAULT_SUMMARY_TIMEOUT_MS);
  const pageTimeoutMs = boundedTimeout(options.pageTimeoutMs, DEFAULT_PAGE_TIMEOUT_MS);
  const now = options.now || Date.now;

  async function request(url, resource, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    } catch (error) {
      const timedOut = error?.name === 'AbortError';
      throw holdersError(
        timedOut ? `Blockscout ${resource} request timed out` : `Blockscout ${resource} request failed`,
        timedOut ? 'timeout' : 'transport_error',
        { retryable: true },
      );
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw holdersError(`Blockscout ${resource} returned HTTP ${response.status}`, 'http_error', {
        httpStatus: response.status,
        retryable,
        retryAfter: response.headers?.get?.('retry-after'),
      });
    }
    try {
      return await response.json();
    } catch (_) {
      throw holdersError(`Blockscout ${resource} returned invalid JSON`);
    }
  }

  async function getTokenHolderSummary(tokenAddress) {
    const address = normalizeTokenAddress('robinhood', tokenAddress);
    const payload = await request(new URL(address, baseUrl), 'holder summary', summaryTimeoutMs);
    if (!payload) return Object.freeze({
      address, available: false, holderCount: null, totalSupplyRaw: null,
      decimals: null, source: 'blockscout', observedAt: null,
    });
    return normalizeSummary(address, payload, now);
  }

  async function getTokenHoldersPage(tokenAddress, encodedCursor) {
    const address = normalizeTokenAddress('robinhood', tokenAddress);
    const cursor = decodeCursor(encodedCursor);
    const url = new URL(`${address}/holders`, baseUrl);
    if (cursor) Object.entries(cursor).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    const payload = await request(url, 'holders page', pageTimeoutMs);
    if (!payload) throw holdersError('Blockscout holders page was not found', 'not_found', { httpStatus: 404 });
    return normalizePage(address, payload, cursor, now);
  }

  return Object.freeze({ getTokenHolderSummary, getTokenHoldersPage });
}

module.exports = {
  DEFAULT_BASE_URL, DEFAULT_PAGE_TIMEOUT_MS, DEFAULT_SUMMARY_TIMEOUT_MS,
  RobinhoodBlockscoutHoldersError, createRobinhoodBlockscoutHoldersClient,
  validateHoldersCursor,
  __private: { addressType, decodeCursor, encodeCursor, normalizeHolder, normalizePage, normalizeSummary },
};
