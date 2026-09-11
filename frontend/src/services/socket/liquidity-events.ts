import type { RealtimeLatencyMarks } from './market-events';
import { normalizeLatencyMarks, normalizeMarketSubscription } from './market-events';

export interface RobinhoodLiquidityPool {
  protocol: 'uniswap-v2' | 'uniswap-v3' | 'uniswap-v4';
  marketKey: string;
  poolAddress: string | null;
  poolId: string | null;
  liquidityUsd: number;
}

export interface MarketLiquidityUpdateEvent {
  type: 'market:liquidity';
  chain: 'robinhood';
  address: string;
  liquidityUsd: number | null;
  liquidityProjectionCommittedAt: string;
  liquidityCoverage: 'complete' | 'partial' | 'unavailable';
  liquidityMarketCount: number;
  valuedLiquidityMarketCount: number;
  liquidityIsLowerBound: boolean;
  liquidityPools: RobinhoodLiquidityPool[];
  latency?: RealtimeLatencyMarks;
}

export interface LiquidityProjectionTarget {
  chain?: unknown;
  address?: unknown;
  liquidityUsd?: number | null;
  liquidityProjectionCommittedAt?: string | null;
  liquidityCoverage?: 'complete' | 'partial' | 'unavailable' | null;
  liquidityMarketCount?: number | null;
  valuedLiquidityMarketCount?: number | null;
  liquidityIsLowerBound?: boolean;
  liquidityPools?: Array<{
    protocol: string;
    marketKey: string;
    poolAddress?: string | null;
    poolId?: string | null;
    liquidityUsd: number;
  }>;
}

const PROTOCOLS = new Set(['uniswap-v2', 'uniswap-v3', 'uniswap-v4']);
const COVERAGE = new Set(['complete', 'partial', 'unavailable']);

function timestamp(value: unknown) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function nonNegativeNumber(value: unknown) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : NaN;
}

function nonNegativeInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizePool(value: unknown): RobinhoodLiquidityPool | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const protocol = String(source.protocol || '');
  const marketKey = String(source.marketKey || '').trim();
  const liquidityUsd = nonNegativeNumber(source.liquidityUsd);
  const poolAddress = source.poolAddress == null ? null : String(source.poolAddress).toLowerCase();
  const poolId = source.poolId == null ? null : String(source.poolId).toLowerCase();
  const identityValid = protocol === 'uniswap-v4'
    ? poolAddress == null && /^0x[0-9a-f]{64}$/.test(poolId || '')
    : poolId == null && /^0x[0-9a-f]{40}$/.test(poolAddress || '');
  if (!PROTOCOLS.has(protocol) || !marketKey || liquidityUsd == null
    || Number.isNaN(liquidityUsd) || !identityValid) return null;
  return { protocol, marketKey, poolAddress, poolId, liquidityUsd } as RobinhoodLiquidityPool;
}

function coverageIsConsistent(input: {
  coverage: string;
  liquidityUsd: number | null;
  marketCount: number;
  valuedCount: number;
  pools: RobinhoodLiquidityPool[];
}) {
  if (input.pools.length !== input.valuedCount || input.valuedCount > input.marketCount) return false;
  if (input.coverage === 'unavailable') {
    return input.valuedCount === 0 && input.liquidityUsd == null;
  }
  if (input.liquidityUsd == null || input.valuedCount === 0) return false;
  return input.coverage === 'complete'
    ? input.valuedCount === input.marketCount
    : input.valuedCount < input.marketCount;
}

export function normalizeMarketLiquidityUpdate(value: unknown): MarketLiquidityUpdateEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const identity = normalizeMarketSubscription(source.address, source.chain);
  const committedAt = timestamp(source.liquidityProjectionCommittedAt);
  const liquidityUsd = nonNegativeNumber(source.liquidityUsd);
  const marketCount = nonNegativeInteger(source.liquidityMarketCount);
  const valuedCount = nonNegativeInteger(source.valuedLiquidityMarketCount);
  const coverage = String(source.liquidityCoverage || '');
  const pools = Array.isArray(source.liquidityPools)
    ? source.liquidityPools.map(normalizePool) : [];
  if (source.type !== 'market:liquidity' || identity?.chain !== 'robinhood'
    || !committedAt || marketCount == null
    || valuedCount == null || Number.isNaN(liquidityUsd) || !COVERAGE.has(coverage)
    || pools.some((pool) => pool == null)) return null;
  const normalizedPools = pools as RobinhoodLiquidityPool[];
  if (!coverageIsConsistent({ coverage, liquidityUsd, marketCount, valuedCount,
    pools: normalizedPools })) return null;
  return {
    type: 'market:liquidity', chain: 'robinhood', address: identity.address,
    liquidityUsd, liquidityProjectionCommittedAt: committedAt,
    liquidityCoverage: coverage as MarketLiquidityUpdateEvent['liquidityCoverage'],
    liquidityMarketCount: marketCount, valuedLiquidityMarketCount: valuedCount,
    liquidityIsLowerBound: coverage === 'partial', liquidityPools: normalizedPools,
    latency: { ...(normalizeLatencyMarks(source.latency) || {}), projectionCommittedAt: committedAt },
  };
}

export function markMarketLiquidityReceived(
  event: MarketLiquidityUpdateEvent,
  receivedAt = Date.now(),
) {
  return { ...event, latency: {
    ...(event.latency || {}), clientReceivedAt: new Date(receivedAt).toISOString(),
  } };
}

export function newestLiquidityProjection<T extends LiquidityProjectionTarget>(...values: T[]) {
  return values.reduce<T | null>((selected, value) => {
    const current = Date.parse(String(selected?.liquidityProjectionCommittedAt || ''));
    const candidate = Date.parse(String(value?.liquidityProjectionCommittedAt || ''));
    return Number.isFinite(candidate) && (!Number.isFinite(current) || candidate > current)
      ? value : selected;
  }, values[0] || null);
}

export function applyLiquidityProjection<T extends LiquidityProjectionTarget>(
  current: T,
  event: MarketLiquidityUpdateEvent,
): T | null {
  const identity = normalizeMarketSubscription(current.address, current.chain);
  if (identity?.chain !== event.chain || identity.address !== event.address) return null;
  const selected = newestLiquidityProjection<LiquidityProjectionTarget>(current, event);
  return selected === current ? null : { ...current,
    liquidityUsd: event.liquidityUsd,
    liquidityProjectionCommittedAt: event.liquidityProjectionCommittedAt,
    liquidityCoverage: event.liquidityCoverage,
    liquidityMarketCount: event.liquidityMarketCount,
    valuedLiquidityMarketCount: event.valuedLiquidityMarketCount,
    liquidityIsLowerBound: event.liquidityIsLowerBound,
    liquidityPools: event.liquidityPools,
  };
}
