const { createTokenIdentity, tokenIdentityKey } = require('../utils/token-identity');
const { normalizeAsOf } = require('./workspace-window-metrics');

const TOP_PERFORMER_VOLUME_SLOTS = 7;
const TOP_PERFORMER_MAX_PCHANGE_24H = 300;
const DEFAULT_MONITORED_SORTS = Object.freeze([
  Object.freeze({ mode: 'vol', window: '5m' }),
]);
const MONITORED_VOLUME_FIELDS = Object.freeze({
  '5m': 'volume5mUsd',
  '1h': 'volume1hUsd',
  '6h': 'volume6hUsd',
  '24h': 'volume24hUsd',
});
const COVERAGE_ORDER = Object.freeze({ complete: 0, partial: 1, unavailable: 2 });
const MAX_MONITORED_PAGE_SIZE = 100;
const MAX_MONITORED_PREFIX = 500;
const MAX_MONITORED_SORTS = 8;

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rowIdentity(row) {
  return tokenIdentityKey(row.chain || 'solana', row.address);
}

function mergeIdentityRows(groups = []) {
  const rowsByIdentity = new Map();
  for (const row of groups.flat()) {
    rowsByIdentity.set(rowIdentity(row), row);
  }
  return [...rowsByIdentity.values()];
}

function getValuation(row) {
  return row.chain === 'robinhood'
    ? numberOrZero(row.last_fdv)
    : numberOrZero(row.last_mcap);
}

function getMonitoredSortValue(row, sort) {
  if (sort.mode === 'mcap') return getValuation(row);
  if (sort.mode === 'age') return numberOrZero(row.last_token_created_at_ms);
  return numberOrZero(row[`last_vol_${sort.window}`]);
}

function getSortDirection(sort) {
  if ((sort.mode === 'mcap' && sort.window === 'lowest')
    || (sort.mode === 'age' && sort.window === 'oldest')) return 1;
  return -1;
}

function compareText(left, right) {
  const normalizedLeft = String(left || '');
  const normalizedRight = String(right || '');
  return normalizedLeft === normalizedRight ? 0 : (normalizedLeft < normalizedRight ? -1 : 1);
}

function finiteNumberOrNull(value, label) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

function normalizedIdentity(row) {
  const chain = row?.identity?.chain || row?.chain;
  const address = row?.identity?.address || row?.address;
  return createTokenIdentity(chain, address);
}

function coverageState(row, window, value) {
  if (value == null) return 'unavailable';
  const raw = row?.coverage?.[window];
  const state = typeof raw === 'object' && raw !== null ? raw.state : raw;
  return Object.prototype.hasOwnProperty.call(COVERAGE_ORDER, state)
    ? state : 'unavailable';
}

function compareNullable(left, right, direction = -1) {
  if (left == null) return right == null ? 0 : 1;
  if (right == null) return -1;
  return (left - right) * direction;
}

function compareVolume(left, right, window) {
  const field = MONITORED_VOLUME_FIELDS[window];
  const leftValue = finiteNumberOrNull(left[field], `${window} volume`);
  const rightValue = finiteNumberOrNull(right[field], `${window} volume`);
  const coverageDelta = COVERAGE_ORDER[coverageState(left, window, leftValue)]
    - COVERAGE_ORDER[coverageState(right, window, rightValue)];
  return coverageDelta || compareNullable(leftValue, rightValue);
}

function normalizedValuation(row) {
  return finiteNumberOrNull(row?.valuation?.usd, 'valuation');
}

function normalizedAge(row) {
  const value = row?.tokenCreatedAt;
  if (value == null || value === '') return null;
  if (typeof value === 'number') return finiteNumberOrNull(value, 'token age');
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) throw new Error('token age is invalid');
  return parsed;
}

function compareNormalizedCriterion(left, right, sort) {
  if (sort.mode === 'vol') return compareVolume(left, right, sort.window);
  if (sort.mode === 'mcap') {
    return compareNullable(
      normalizedValuation(left), normalizedValuation(right),
      sort.window === 'lowest' ? 1 : -1,
    );
  }
  return compareNullable(
    normalizedAge(left), normalizedAge(right), sort.window === 'oldest' ? 1 : -1,
  );
}

function compareNormalizedMonitoredRows(left, right, sorts = DEFAULT_MONITORED_SORTS) {
  for (const sort of sorts) {
    const delta = compareNormalizedCriterion(left, right, sort);
    if (delta !== 0) return delta;
  }
  const leftIdentity = normalizedIdentity(left);
  const rightIdentity = normalizedIdentity(right);
  return compareNullable(normalizedAge(left), normalizedAge(right))
    || compareNullable(normalizedValuation(left), normalizedValuation(right))
    || compareText(leftIdentity.chain, rightIdentity.chain)
    || compareText(leftIdentity.address, rightIdentity.address);
}

function normalizePositiveInteger(value, fallback, label, minimum = 0) {
  const parsed = value == null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

function normalizeMonitoredSort(sort) {
  const mode = String(sort?.mode || '').trim().toLowerCase();
  const window = String(sort?.window || '').trim().toLowerCase();
  const valid = (mode === 'vol' && Object.hasOwn(MONITORED_VOLUME_FIELDS, window))
    || (mode === 'mcap' && ['highest', 'lowest'].includes(window))
    || (mode === 'age' && ['newest', 'oldest'].includes(window));
  if (!valid) throw new Error('invalid monitored sort criterion');
  return Object.freeze({ mode, window });
}

function normalizeMonitoredQuery(input = {}) {
  const page = normalizePositiveInteger(input.page, 0, 'monitored page');
  const perPage = normalizePositiveInteger(input.perPage, 30, 'monitored page size', 1);
  if (perPage > MAX_MONITORED_PAGE_SIZE) {
    throw new Error(`monitored page size cannot exceed ${MAX_MONITORED_PAGE_SIZE}`);
  }
  const requiredPrefix = (page + 1) * perPage;
  if (!Number.isSafeInteger(requiredPrefix) || requiredPrefix > MAX_MONITORED_PREFIX) {
    throw new Error(`monitored prefix cannot exceed ${MAX_MONITORED_PREFIX}`);
  }
  const requestedSorts = input.sorts == null ? DEFAULT_MONITORED_SORTS : input.sorts;
  if (!Array.isArray(requestedSorts) || !requestedSorts.length
    || requestedSorts.length > MAX_MONITORED_SORTS) {
    throw new Error('monitored sorts are invalid');
  }
  return Object.freeze({
    asOf: normalizeAsOf(input.asOf || new Date()).toISOString(),
    page,
    perPage,
    requiredPrefix,
    sorts: Object.freeze(requestedSorts.map(normalizeMonitoredSort)),
  });
}

function normalizePrefix(prefix, query, seenChains) {
  const chain = String(prefix?.chain || '').trim().toLowerCase();
  if (!chain || seenChains.has(chain)) throw new Error('monitored prefix chain is invalid');
  seenChains.add(chain);
  const asOf = new Date(prefix?.asOf);
  if (!Number.isFinite(asOf.getTime()) || asOf.toISOString() !== query.asOf) {
    throw new Error(`${chain} snapshot does not match monitored query`);
  }
  const total = normalizePositiveInteger(prefix.total, null, `${chain} total`);
  if (!Array.isArray(prefix.rows)) throw new Error(`${chain} prefix rows are invalid`);
  if (prefix.rows.length > query.requiredPrefix) {
    throw new Error(`${chain} prefix exceeds required prefix ${query.requiredPrefix}`);
  }
  const rows = [];
  const identities = new Set();
  for (const row of prefix.rows) {
    const identity = normalizedIdentity(row);
    if (identity.chain !== chain) throw new Error(`${chain} prefix contains another chain`);
    if (rows.length && compareNormalizedMonitoredRows(rows.at(-1), row, query.sorts) > 0) {
      throw new Error(`${chain} prefix is not sorted`);
    }
    rows.push(row);
    identities.add(identity.key);
  }
  const required = Math.min(total, query.requiredPrefix);
  if (identities.size > total) {
    throw new Error(`${chain} prefix contains more identities than its total`);
  }
  if (identities.size < required) {
    throw new Error(`${chain} prefix returned ${identities.size} rows; ${required} required`);
  }
  return { total, rows };
}

function buildExactMonitoredPage(prefixes, input = {}) {
  if (!Array.isArray(prefixes)) throw new Error('monitored prefixes are invalid');
  const query = normalizeMonitoredQuery(input);
  const seenChains = new Set();
  const rowsByIdentity = new Map();
  let total = 0;
  for (const prefix of prefixes) {
    const normalized = normalizePrefix(prefix, query, seenChains);
    total += normalized.total;
    if (!Number.isSafeInteger(total)) throw new Error('monitored total is outside safe range');
    for (const row of normalized.rows) {
      rowsByIdentity.set(normalizedIdentity(row).key, row);
    }
  }
  const sorted = [...rowsByIdentity.values()].sort((left, right) => (
    compareNormalizedMonitoredRows(left, right, query.sorts)
  ));
  const offset = query.page * query.perPage;
  const rows = sorted.slice(offset, offset + query.perPage);
  return Object.freeze({
    asOf: query.asOf,
    total,
    page: query.page,
    perPage: query.perPage,
    requiredPrefix: query.requiredPrefix,
    hasMore: offset + rows.length < total,
    rows: Object.freeze(rows),
  });
}

function compareMonitoredRows(left, right, sorts = []) {
  const effectiveSorts = Array.isArray(sorts) && sorts.length
    ? sorts : [{ mode: 'vol', window: '5m' }];
  for (const sort of effectiveSorts) {
    const delta = getMonitoredSortValue(left, sort) - getMonitoredSortValue(right, sort);
    if (delta !== 0) return delta * getSortDirection(sort);
  }
  const ageDelta = numberOrZero(right.last_token_created_at_ms)
    - numberOrZero(left.last_token_created_at_ms);
  if (ageDelta !== 0) return ageDelta;
  const valuationDelta = getValuation(right) - getValuation(left);
  if (valuationDelta !== 0) return valuationDelta;
  return compareText(rowIdentity(left), rowIdentity(right));
}

function buildMonitoredSlice(groups, options = {}) {
  const page = Math.max(0, Math.trunc(Number(options.page) || 0));
  const perPage = Math.max(1, Math.trunc(Number(options.perPage) || 30));
  const sorted = mergeIdentityRows(groups).sort((left, right) => (
    compareMonitoredRows(left, right, options.sorts)
  ));
  const offset = page * perPage;
  return {
    total: sorted.length,
    page,
    perPage,
    rows: sorted.slice(offset, offset + perPage),
  };
}

function cumeDistBy(rows, readValue) {
  const sorted = rows.map(readValue).sort((left, right) => left - right);
  const scores = new Map();
  for (let index = 0; index < sorted.length;) {
    let end = index + 1;
    while (end < sorted.length && sorted[end] === sorted[index]) end += 1;
    scores.set(sorted[index], end / sorted.length);
    index = end;
  }
  return scores;
}

function compareNumberDesc(left, right, readValue) {
  return readValue(right) - readValue(left);
}

function compareTopTieBreakers(left, right) {
  return compareNumberDesc(left, right, (row) => numberOrZero(row.last_vol_24h))
    || compareNumberDesc(left, right, getValuation)
    || compareNumberDesc(left, right, (row) => new Date(row.last_seen_at || 0).getTime())
    || compareText(rowIdentity(left), rowIdentity(right));
}

function rankTopPerformerRows(groups, options = {}) {
  const limit = Math.max(1, Math.trunc(Number(options.limit) || 15));
  const maxPchange24h = Math.max(1,
    numberOrZero(options.maxPchange24h) || TOP_PERFORMER_MAX_PCHANGE_24H);
  const candidates = mergeIdentityRows(groups).map((row) => ({
    ...row,
    pchange_score_input: Math.min(maxPchange24h,
      Math.max(0, numberOrZero(row.last_price_change_24h))),
    volume_score_input: Math.log1p(Math.max(0, numberOrZero(row.last_vol_24h))),
  }));
  if (!candidates.length) return [];

  const volumeCume = cumeDistBy(candidates, (row) => row.volume_score_input);
  const pchangeCume = cumeDistBy(candidates, (row) => row.pchange_score_input);
  const ranked = candidates.map((row) => ({
    ...row,
    volume_rank_score: volumeCume.get(row.volume_score_input),
    pchange_rank_score: pchangeCume.get(row.pchange_score_input),
  }));
  const volumeSlots = Math.min(TOP_PERFORMER_VOLUME_SLOTS, limit);
  const volumePicks = [...ranked].sort((left, right) => (
    compareNumberDesc(left, right, (row) => row.volume_score_input)
    || compareNumberDesc(left, right, (row) => row.pchange_score_input)
    || compareTopTieBreakers(left, right)
  )).slice(0, volumeSlots).map((row) => ({
    ...row,
    performance_bucket: 'volume_24h',
    performance_score: ((row.volume_rank_score * 0.82)
      + (row.pchange_rank_score * 0.18)) * 100,
  }));
  const selected = new Set(volumePicks.map(rowIdentity));
  const pchangePicks = ranked.filter((row) => !selected.has(rowIdentity(row)))
    .sort((left, right) => (
      compareNumberDesc(left, right, (row) => row.pchange_score_input)
      || compareNumberDesc(left, right, (row) => row.pchange_rank_score)
      || compareNumberDesc(left, right, (row) => row.volume_rank_score)
      || compareTopTieBreakers(left, right)
    )).slice(0, Math.max(0, limit - volumePicks.length)).map((row) => ({
      ...row,
      performance_bucket: 'pchange_24h',
      performance_score: ((row.pchange_rank_score * 0.82)
        + (row.volume_rank_score * 0.18)) * 100,
    }));

  return [...volumePicks, ...pchangePicks].sort((left, right) => (
    compareNumberDesc(left, right, (row) => row.performance_score)
    || compareNumberDesc(left, right, (row) => row.volume_rank_score)
    || compareNumberDesc(left, right, (row) => row.pchange_rank_score)
    || compareNumberDesc(left, right, (row) => numberOrZero(row.last_price_change_24h))
    || compareTopTieBreakers(left, right)
  )).slice(0, limit);
}

module.exports = {
  buildExactMonitoredPage,
  buildMonitoredSlice,
  compareNormalizedMonitoredRows,
  mergeIdentityRows,
  normalizeMonitoredQuery,
  rankTopPerformerRows,
  __private: { compareMonitoredRows, cumeDistBy, getValuation, rowIdentity },
};
