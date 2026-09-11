'use strict';
const PROTOCOLS = new Set(['uniswap-v2', 'uniswap-v3', 'uniswap-v4']);
const COVERAGE = new Set(['complete', 'partial', 'unavailable']);
function count(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
function amount(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : NaN;
}
function validEnvelope(value) {
  return value.chain === 'robinhood' && /^0x[0-9a-f]{40}$/.test(value.address)
    && Number.isFinite(value.committedAtMs) && value.marketCount != null
    && value.valuedCount != null && value.valuedCount <= value.marketCount
    && !Number.isNaN(value.liquidityUsd) && COVERAGE.has(value.coverage);
}
function normalizePools(payload) {
  return (Array.isArray(payload?.liquidityPools) ? payload.liquidityPools : []).map((pool) => ({
    protocol: String(pool?.protocol || ''), marketKey: String(pool?.marketKey || ''),
    poolAddress: pool?.poolAddress == null ? null : String(pool.poolAddress).toLowerCase(),
    poolId: pool?.poolId == null ? null : String(pool.poolId).toLowerCase(),
    liquidityUsd: amount(pool?.liquidityUsd),
  }));
}
function normalizeRobinhoodLiquidityRealtimeEvent(payload) {
  const value = {
    chain: String(payload?.chain || '').toLowerCase(),
    address: String(payload?.address || '').trim().toLowerCase(),
    committedAtMs: Date.parse(String(payload?.liquidityProjectionCommittedAt || '')),
    marketCount: count(payload?.liquidityMarketCount),
    valuedCount: count(payload?.valuedLiquidityMarketCount),
    liquidityUsd: amount(payload?.liquidityUsd), coverage: String(payload?.liquidityCoverage || ''),
  };
  if (!validEnvelope(value)) return null;
  const pools = normalizePools(payload);
  if (pools.length !== value.valuedCount || pools.some((pool) => !PROTOCOLS.has(pool.protocol)
    || !pool.marketKey || pool.liquidityUsd == null || Number.isNaN(pool.liquidityUsd))) return null;
  return Object.freeze({
    ...payload, type: 'market:liquidity', chain: 'robinhood', address: value.address,
    liquidityUsd: value.liquidityUsd,
    liquidityProjectionCommittedAt: new Date(value.committedAtMs).toISOString(),
    liquidityCoverage: value.coverage, liquidityMarketCount: value.marketCount,
    valuedLiquidityMarketCount: value.valuedCount, liquidityPools: pools,
    liquidityIsLowerBound: value.liquidityUsd != null && value.coverage === 'partial',
  });
}
module.exports = { normalizeRobinhoodLiquidityRealtimeEvent };
