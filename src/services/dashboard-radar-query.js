const {
  createTokenIdentity,
  normalizeTokenChain,
  parseTokenIdentityKey,
} = require('../utils/token-identity');
const { normalizeAsOf } = require('./workspace-window-metrics');

const SEVEN_DAYS_MINUTES = 7 * 24 * 60;
const MAX_AGE_MINUTES = 100 * 365 * 24 * 60;
const MAX_PAGE_SIZE = 100;
const MAX_PREFIX = 500;
const MAX_SORTS = 8;
const MAX_IDENTITIES = 5000;
const CHAINS = new Set(['solana', 'robinhood']);
const COVERAGE_ORDER = Object.freeze({ complete: 0, partial: 1, unavailable: 2 });
const VOLUME_FIELDS = Object.freeze({
  '1h': 'volume1hUsd', '6h': 'volume6hUsd', '24h': 'volume24hUsd',
});
const PRICE_CHANGE_FIELDS = Object.freeze({
  '1h': 'priceChange1hPct', '6h': 'priceChange6hPct', '24h': 'priceChange24hPct',
});
const DEFAULT_SORTS = Object.freeze([
  Object.freeze({ mode: 'vol', window: '1h' }),
  Object.freeze({ mode: 'vol', window: '6h' }),
]);

function integer(value, fallback, label, minimum = 0) {
  const parsed = value == null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${label} is invalid`);
  return parsed;
}

function valuationBound(value, fallback, label) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} is invalid`);
  return parsed === 0 && label.startsWith('max') ? null : parsed;
}

function normalizeChains(values) {
  const source = values == null ? ['solana'] : values;
  if (!Array.isArray(source) || !source.length) throw new Error('radar chains are invalid');
  const chains = [...new Set(source.map((value) => normalizeTokenChain(value)))];
  if (chains.some((chain) => !CHAINS.has(chain))) throw new Error('radar chain is unavailable');
  return Object.freeze(chains);
}

function normalizeIdentity(value) {
  return typeof value === 'string'
    ? parseTokenIdentityKey(value)
    : createTokenIdentity(value?.chain, value?.address);
}

function normalizeIdentities(values, chains, label) {
  if (values == null) return Object.freeze([]);
  if (!Array.isArray(values) || values.length > MAX_IDENTITIES) {
    throw new Error(`${label} are invalid`);
  }
  const selected = new Set(chains);
  const identities = new Map();
  for (const value of values) {
    const identity = normalizeIdentity(value);
    if (selected.has(identity.chain)) identities.set(identity.key, identity);
  }
  return Object.freeze([...identities.values()]);
}

function normalizeSort(value) {
  const mode = String(value?.mode || '').trim().toLowerCase();
  const window = String(value?.window || '').trim().toLowerCase();
  const valid = (mode === 'vol' && Object.hasOwn(VOLUME_FIELDS, window))
    || (mode === 'pchange' && Object.hasOwn(PRICE_CHANGE_FIELDS, window))
    || (mode === 'mcap' && ['highest', 'lowest'].includes(window))
    || (mode === 'age' && ['newest', 'oldest'].includes(window));
  if (!valid) throw new Error('invalid radar sort criterion');
  return Object.freeze({ mode, window });
}

function normalizeSorts(values) {
  const source = values == null ? DEFAULT_SORTS : values;
  if (!Array.isArray(source) || !source.length || source.length > MAX_SORTS) {
    throw new Error('radar sorts are invalid');
  }
  const normalized = source.map(normalizeSort);
  if (new Set(normalized.map((sort) => `${sort.mode}:${sort.window}`)).size !== normalized.length) {
    throw new Error('radar sorts contain duplicates');
  }
  return Object.freeze(normalized);
}

function normalizeAgeRange(input, bucket) {
  const defaultMin = bucket === 'oldWeek' ? SEVEN_DAYS_MINUTES : 0;
  const defaultMax = bucket === 'recent' ? SEVEN_DAYS_MINUTES : null;
  const min = integer(input.ageMinMinutes, defaultMin, 'radar minimum age');
  const parsedMax = input.ageMaxMinutes == null || input.ageMaxMinutes === ''
    ? defaultMax : integer(input.ageMaxMinutes, null, 'radar maximum age');
  const max = bucket === 'oldWeek' && parsedMax === 0 ? null : parsedMax;
  if (min > MAX_AGE_MINUTES || (max != null && (max > MAX_AGE_MINUTES || max < min))) {
    throw new Error('radar age range is invalid');
  }
  if (bucket === 'recent' && max > SEVEN_DAYS_MINUTES) {
    throw new Error('recent radar age cannot exceed seven days');
  }
  if (bucket === 'oldWeek' && min < SEVEN_DAYS_MINUTES) {
    throw new Error('old-week radar age cannot be below seven days');
  }
  return { ageMinMinutes: min, ageMaxMinutes: max };
}

function normalizeRadarQuery(input = {}) {
  const bucket = input.bucket === 'oldWeek' ? 'oldWeek' : 'recent';
  const page = integer(input.page, 0, 'radar page');
  const perPage = integer(input.perPage, 30, 'radar page size', 1);
  if (perPage > MAX_PAGE_SIZE || ((page + 1) * perPage) > MAX_PREFIX) {
    throw new Error(`radar prefix cannot exceed ${MAX_PREFIX}`);
  }
  const chains = normalizeChains(input.chains);
  const minMcap = valuationBound(input.minMcap, 30_000, 'minMcap');
  const maxMcap = valuationBound(input.maxMcap, null, 'maxMcap');
  const minFdv = valuationBound(input.minFdv, 30_000, 'minFdv');
  const maxFdv = valuationBound(input.maxFdv, null, 'maxFdv');
  if ((maxMcap != null && maxMcap < minMcap) || (maxFdv != null && maxFdv < minFdv)) {
    throw new Error('radar valuation range is invalid');
  }
  const dismissed = normalizeIdentities(input.dismissedIdentities, chains, 'dismissed identities');
  const starred = normalizeIdentities(input.starredIdentities, chains, 'starred identities');
  const starredOnly = input.starredOnly === true;
  return Object.freeze({
    asOf: normalizeAsOf(input.asOf || new Date()).toISOString(),
    bucket, page, perPage, requiredPrefix: (page + 1) * perPage, chains,
    sorts: normalizeSorts(input.sorts), minMcap, maxMcap, minFdv, maxFdv,
    ...normalizeAgeRange(input, bucket),
    searchQuery: String(input.searchQuery || '').trim().toLowerCase().slice(0, 200),
    dismissedIdentities: dismissed,
    starredIdentities: starred,
    starredOnly,
    empty: starredOnly && starred.length === 0,
  });
}

function timestampMs(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) ? numeric : new Date(value).getTime();
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveRadarTokenAge(input = {}) {
  const nativeTimestamp = timestampMs(input.tokenCreatedAt);
  if (nativeTimestamp != null) {
    return Object.freeze({ state: 'known', timestampMs: nativeTimestamp,
      provenance: 'chain-native' });
  }
  const firstSeenTimestamp = timestampMs(input.firstSeenAt);
  if (firstSeenTimestamp != null) {
    return Object.freeze({ state: 'known', timestampMs: firstSeenTimestamp,
      provenance: 'first-seen' });
  }
  return Object.freeze({ state: 'unknown', timestampMs: null, provenance: 'unknown' });
}

function isRadarAgeInQuery(age, query) {
  if (age?.state !== 'known') return false;
  const ageMinutes = (new Date(query.asOf).getTime() - age.timestampMs) / 60_000;
  return ageMinutes >= query.ageMinMinutes
    && (query.ageMaxMinutes == null || ageMinutes <= query.ageMaxMinutes);
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error('radar sort value is invalid');
  return parsed;
}

function compareNullable(left, right, direction = -1) {
  if (left == null) return right == null ? 0 : 1;
  if (right == null) return -1;
  return (left - right) * direction;
}

function coverage(row, field, window) {
  const state = row?.[field]?.[window];
  return Object.hasOwn(COVERAGE_ORDER, state) ? state : 'unavailable';
}

function compareCriterion(left, right, sort) {
  if (sort.mode === 'vol') {
    const field = VOLUME_FIELDS[sort.window];
    const valueDelta = compareNullable(finiteOrNull(left[field]), finiteOrNull(right[field]));
    const coverageDelta = COVERAGE_ORDER[coverage(left, 'coverage', sort.window)]
      - COVERAGE_ORDER[coverage(right, 'coverage', sort.window)];
    return valueDelta || coverageDelta;
  }
  if (sort.mode === 'pchange') {
    const field = PRICE_CHANGE_FIELDS[sort.window];
    const coverageDelta = COVERAGE_ORDER[coverage(left, 'priceChangeCoverage', sort.window)]
      - COVERAGE_ORDER[coverage(right, 'priceChangeCoverage', sort.window)];
    return coverageDelta || compareNullable(finiteOrNull(left[field]), finiteOrNull(right[field]));
  }
  if (sort.mode === 'mcap') {
    return compareNullable(finiteOrNull(left?.valuation?.usd), finiteOrNull(right?.valuation?.usd),
      sort.window === 'lowest' ? 1 : -1);
  }
  return compareNullable(left?.tokenAge?.timestampMs ?? null, right?.tokenAge?.timestampMs ?? null,
    sort.window === 'oldest' ? 1 : -1);
}

function compareRadarRows(left, right, sorts = DEFAULT_SORTS) {
  for (const sort of sorts) {
    const result = compareCriterion(left, right, sort);
    if (result) return result;
  }
  const leftIdentity = normalizeIdentity(left.identity);
  const rightIdentity = normalizeIdentity(right.identity);
  return leftIdentity.key.localeCompare(rightIdentity.key);
}

module.exports = {
  compareRadarRows,
  isRadarAgeInQuery,
  normalizeRadarQuery,
  resolveRadarTokenAge,
};
