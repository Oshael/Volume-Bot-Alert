const { createTokenIdentity } = require('../utils/token-identity');
const { MAX_CATALOG_FDV_USD } = require('./robinhood-catalog-fdv-policy');

const SCORE_VERSION = 'trending-v1';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_POLICY = Object.freeze({
  weights: Object.freeze({ volume24h: 0.55, acceleration5m: 0.20,
    priceChange1h: 0.20, priceChange6h: 0.05 }),
  accelerationCap: 12,
  change1hCap: 150,
  change6hCap: 300,
  denominatorFloor: 1,
  freshnessMs: 15 * 60 * 1000,
  minLiquidityUsd: 0,
  minValuationUsd: 30_000,
  maxValuationUsd: MAX_CATALOG_FDV_USD,
  minVolume24hUsd: 1,
});

function finite(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestamp(value) {
  const parsed = new Date(value || '').getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function completeYoungWindow(row, asOfMs) {
  if (row.coverage?.['24h'] === 'complete') return true;
  const createdAt = finite(row.tokenCreatedAt);
  const startAt = timestamp(row.coverageProvenance?.startAt);
  return row.coverage?.['24h'] === 'partial'
    && row.coverageProvenance?.caughtUp === true
    && createdAt != null && asOfMs - createdAt >= 0 && asOfMs - createdAt < DAY_MS
    && startAt != null && startAt <= createdAt;
}

function hasRequiredCoverage(row, asOfMs) {
  return row.coverage?.['5m'] === 'complete'
    && row.coverage?.['1h'] === 'complete'
    && completeYoungWindow(row, asOfMs)
    && row.priceChangeCoverage?.['1h'] === 'complete'
    && row.priceChangeCoverage?.['6h'] === 'complete';
}

function passesPolicy(values, policy, asOfMs) {
  const volumeReady = values.volumes.every((value) => value != null && value >= 0);
  const marketReady = values.change1h != null && values.change6h != null
    && values.valuation >= policy.minValuationUsd
    && values.valuation < policy.maxValuationUsd
    && (policy.minLiquidityUsd === 0 || values.liquidity >= policy.minLiquidityUsd)
    && values.volume24h >= policy.minVolume24hUsd;
  const fresh = values.observedAt != null && values.observedAt <= asOfMs
    && asOfMs - values.observedAt <= policy.freshnessMs;
  return volumeReady && marketReady && fresh;
}

function normalizeCandidate(row, policy, asOfMs) {
  let identity;
  try { identity = createTokenIdentity(row?.identity?.chain, row?.identity?.address); } catch (_) {
    return null;
  }
  const volume5m = finite(row.volume5mUsd);
  const volume1h = finite(row.volume1hUsd);
  const volume24h = finite(row.volume24hUsd);
  const change1h = finite(row.priceChange1hPct);
  const change6h = finite(row.priceChange6hPct);
  const valuation = finite(row.valuation?.usd);
  const liquidity = finite(row.liquidityUsd);
  const observedAt = timestamp(row.lastActivityAt);
  if (!hasRequiredCoverage(row, asOfMs) || !passesPolicy({
    volumes: [volume5m, volume1h, volume24h], volume24h,
    change1h, change6h, valuation, liquidity, observedAt,
  }, policy, asOfMs)) return null;
  const expected5m = Math.max(volume1h / 12, volume24h / 288, policy.denominatorFloor);
  return { identity, row, observedAt, volume5m, volume24h,
    acceleration5m: Math.min(policy.accelerationCap, Math.max(0, volume5m / expected5m)),
    change1h: Math.min(policy.change1hCap, Math.max(0, change1h)),
    change6h: Math.min(policy.change6hCap, Math.max(0, change6h)) };
}

function percentileMap(rows, read) {
  const sorted = rows.map(read).sort((left, right) => left - right);
  const result = new Map();
  for (let index = 0; index < sorted.length;) {
    let end = index + 1;
    while (end < sorted.length && sorted[end] === sorted[index]) end += 1;
    result.set(sorted[index], end / sorted.length);
    index = end;
  }
  return result;
}

function rankTrendingTokens(rows, options = {}) {
  const overrides = options.policy || {};
  const policy = Object.freeze({ ...DEFAULT_POLICY, ...overrides,
    weights: Object.freeze({ ...DEFAULT_POLICY.weights, ...(overrides.weights || {}) }) });
  const asOfMs = timestamp(options.asOf || new Date());
  if (asOfMs == null) throw new RangeError('trending asOf is invalid');
  const byIdentity = new Map();
  for (const row of rows || []) {
    const candidate = normalizeCandidate(row, policy, asOfMs);
    const current = candidate && byIdentity.get(candidate.identity.key);
    if (candidate && (!current || candidate.observedAt > current.observedAt)) {
      byIdentity.set(candidate.identity.key, candidate);
    }
  }
  const candidates = [...byIdentity.values()];
  if (!candidates.length) return Object.freeze([]);
  const inputs = {
    volume24h: percentileMap(candidates, (item) => Math.log1p(item.volume24h)),
    acceleration5m: percentileMap(candidates, (item) => Math.log1p(item.acceleration5m)),
    priceChange1h: percentileMap(candidates, (item) => item.change1h),
    priceChange6h: percentileMap(candidates, (item) => item.change6h),
  };
  const ranked = candidates.map((item) => {
    const components = Object.freeze({
      volume24hPercentile: inputs.volume24h.get(Math.log1p(item.volume24h)),
      acceleration5mPercentile: inputs.acceleration5m.get(Math.log1p(item.acceleration5m)),
      priceChange1hPercentile: inputs.priceChange1h.get(item.change1h),
      priceChange6hPercentile: inputs.priceChange6h.get(item.change6h),
    });
    const score = (policy.weights.volume24h * components.volume24hPercentile)
      + (policy.weights.acceleration5m * components.acceleration5mPercentile)
      + (policy.weights.priceChange1h * components.priceChange1hPercentile)
      + (policy.weights.priceChange6h * components.priceChange6hPercentile);
    return Object.freeze({ ...item, score, components });
  });
  ranked.sort((left, right) => right.score - left.score
    || right.volume24h - left.volume24h || right.volume5m - left.volume5m
    || right.observedAt - left.observedAt
    || left.identity.chain.localeCompare(right.identity.chain)
    || left.identity.address.localeCompare(right.identity.address));
  const limit = Math.min(40, Math.max(1, Number(options.limit) || 40));
  return Object.freeze(ranked.slice(0, limit));
}

module.exports = { DEFAULT_POLICY, SCORE_VERSION, rankTrendingTokens };
