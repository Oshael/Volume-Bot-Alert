const { normalizeTokenAddress } = require('../utils/token-identity');

const GLOBAL_SEARCH_KINDS = Object.freeze(['token', 'wallet']);
const GLOBAL_SEARCH_MAX_LIMIT = 20;
const GLOBAL_SEARCH_MAX_QUERY_LENGTH = 120;

function normalizeKinds(value) {
  const source = value == null || value === ''
    ? ['token']
    : (Array.isArray(value) ? value : String(value).split(','));
  const kinds = [...new Set(source.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
  if (!kinds.length) throw new RangeError('kinds must select at least one result kind');
  if (kinds.some((kind) => !GLOBAL_SEARCH_KINDS.includes(kind))) {
    throw new RangeError('kinds contains an unsupported result kind');
  }
  return Object.freeze(kinds);
}

function normalizeLimit(value) {
  const limit = value == null || value === '' ? GLOBAL_SEARCH_MAX_LIMIT : Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > GLOBAL_SEARCH_MAX_LIMIT) {
    throw new RangeError(`limit must be between 1 and ${GLOBAL_SEARCH_MAX_LIMIT}`);
  }
  return limit;
}

function classifyAddress(query) {
  for (const [classification, chain] of [['evm_address', 'robinhood'], ['solana_address', 'solana']]) {
    try {
      return { classification, normalizedAddress: normalizeTokenAddress(chain, query) };
    } catch (_) {
      // Try the next supported address family before classifying as text.
    }
  }
  return { classification: 'text', normalizedAddress: null };
}

function normalizeGlobalSearchRequest(input = {}) {
  const query = String(input.query ?? input.q ?? '').trim();
  if (!query) throw new RangeError('q is required');
  if (query.length > GLOBAL_SEARCH_MAX_QUERY_LENGTH) {
    throw new RangeError(`q must be at most ${GLOBAL_SEARCH_MAX_QUERY_LENGTH} characters`);
  }
  const classified = classifyAddress(query);
  if (classified.classification === 'text' && query.length < 2) {
    throw new RangeError('text queries must contain at least 2 characters');
  }
  return Object.freeze({
    query,
    ...classified,
    kinds: normalizeKinds(input.kinds),
    limit: normalizeLimit(input.limit),
  });
}

module.exports = {
  GLOBAL_SEARCH_KINDS,
  GLOBAL_SEARCH_MAX_LIMIT,
  GLOBAL_SEARCH_MAX_QUERY_LENGTH,
  normalizeGlobalSearchRequest,
};
