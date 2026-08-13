import type { TokenSparklineCandleItem } from '../api/catalog';
import {
  createTokenIdentity,
  type TokenChain,
  type TokenIdentity,
} from '../../utils/token-chain';

export interface MarketSubscriptionIdentity {
  chain: TokenChain;
  address: string;
}

export interface MarketBucketCandle extends Partial<TokenSparklineCandleItem> {
  bucketTs: string;
  granularityMinutes: number;
  openFdvUsd?: number | null;
  highFdvUsd?: number | null;
  lowFdvUsd?: number | null;
  closeFdvUsd?: number | null;
}

export interface LiveTokenChartCandle extends TokenSparklineCandleItem {
  liveSourceBucketTs: string;
  liveSequence: string;
}

export interface MarketBucketUpdateEvent {
  type: 'market:bucket';
  chain: TokenChain;
  address: string;
  bucketTs: string;
  sequence: string;
  pairAddress?: string | null;
  granularityMinutes: number;
  generatedAt?: string | null;
  activity?: {
    volumeUsd?: unknown;
    currentVolume5mUsd?: unknown;
    volume5mUsd?: unknown;
    volume1hUsd?: unknown;
    volume6hUsd?: unknown;
    volume24hUsd?: unknown;
    prevVolume5mCanonical?: unknown;
    volume5mBaselineAt?: unknown;
    volume5mWindowEnd?: unknown;
    volume5mDeltaCoverage?: unknown;
    swaps?: unknown;
    buys?: unknown;
    sells?: unknown;
    transactions?: unknown;
  } | null;
  valuation?: {
    type?: unknown;
    fdvUsd?: unknown;
    mcapUsd?: unknown;
    priceUsd?: unknown;
    observedAt?: unknown;
  } | null;
  coverage?: Record<string, unknown> | null;
  candle: MarketBucketCandle;
}

export interface MarketTradeUpdateEvent {
  type: 'market:trade';
  chain: 'robinhood';
  address: string;
  transactionHash: string;
  actionIndex: number;
  blockNumber: number;
  blockTime: string;
  side: 'buy' | 'sell';
  walletAddress: string;
  amountUsd: number | null;
  priceUsd: number | null;
  mcUsd: number | null;
}

export interface RealtimeTokenMarketPatch {
  observedAt: string;
  priceUsd: number | null;
  activityState: 'fresh';
  valuationType: 'market-cap' | 'fdv' | null;
  valuation: {
    type: 'mcap' | 'fdv';
    usd: number;
    observedAt: string;
    freshness: 'fresh';
  } | null;
  fdv: number | null;
  mcap: number | null;
  rollingVolumes: {
    volume5m?: number;
    volume1h?: number;
    volume6h?: number;
    volume24h?: number;
  } | null;
  volumeCoverage: Partial<Record<'5m' | '1h' | '6h' | '24h', 'complete' | 'partial' | 'unavailable'>> | null;
  activity: {
    bucketTs: string;
    volumeUsd: number | null;
    swaps: number | null;
    volumeDeltaUsd: number | null;
    swapsDelta: number | null;
    canonicalVolume5m: {
      currentVolumeUsd: number | null;
      previousVolumeUsd: number | null;
      baselineAt: string | null;
      windowEnd: string | null;
      coverage: 'complete' | 'partial' | 'unavailable';
    } | null;
  } | null;
}

export interface RealtimeActivityState {
  bucketTs?: string | null;
  volumeUsd?: number | null;
  swaps?: number | null;
  windowEnd?: string | null;
  prevVolume5mCanonical?: number | null;
  volume5mBaselineAt?: string | null;
  volume5mWindowEnd?: string | null;
  volume5mDeltaCoverage?: 'complete' | 'partial' | 'unavailable' | null;
}

function validTimestamp(value: unknown) {
  const timestamp = String(value || '').trim();
  const timestampMs = Date.parse(timestamp);
  return Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : null;
}

export function normalizeMarketSubscription(
  addressValue: unknown,
  chainValue: unknown = 'solana',
): TokenIdentity | null {
  try {
    return createTokenIdentity(chainValue, addressValue);
  } catch (_) {
    return null;
  }
}

export function normalizeMarketBucketUpdate(value: unknown): MarketBucketUpdateEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const candle = source.candle;
  if (!candle || typeof candle !== 'object' || Array.isArray(candle)) return null;

  const candleSource = candle as Record<string, unknown>;
  if (!String(source.chain || '').trim()) return null;
  const identity = normalizeMarketSubscription(source.address, source.chain);
  const bucketTs = validTimestamp(source.bucketTs ?? candleSource.bucketTs);
  const sequence = String(source.sequence || '').trim();
  const granularityMinutes = Number(source.granularityMinutes ?? candleSource.granularityMinutes);
  if (
    !identity
    || !bucketTs
    || !sequence
    || !Number.isSafeInteger(granularityMinutes)
    || granularityMinutes <= 0
  ) {
    return null;
  }

  return {
    ...source,
    type: 'market:bucket',
    chain: identity.chain,
    address: identity.address,
    bucketTs,
    sequence,
    granularityMinutes,
    candle: {
      ...candleSource,
      bucketTs,
      granularityMinutes,
    },
  } as MarketBucketUpdateEvent;
}

export function getMarketBucketFrameKey(event: MarketBucketUpdateEvent) {
  return `${event.chain}:${event.address}:${event.bucketTs}`;
}

export function upsertOrderedMarketCandle<T extends { bucketTs: string }>(
  candles: readonly T[],
  incoming: T,
  maxCandles: number,
  merge: (existing: T | null, incoming: T) => T | null,
) {
  const incomingMs = Date.parse(incoming.bucketTs);
  if (!Number.isFinite(incomingMs)) return null;

  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Date.parse(candles[middle].bucketTs) < incomingMs) low = middle + 1;
    else high = middle;
  }

  const found = Date.parse(candles[low]?.bucketTs || '') === incomingMs;
  const merged = merge(found ? candles[low] : null, incoming);
  if (!merged) return null;

  const limit = Math.max(1, Math.floor(maxCandles) || 1);
  if (!found && low === candles.length) {
    const nextCandles = candles.slice(Math.max(0, candles.length - limit + 1));
    nextCandles.push(merged);
    return nextCandles;
  }

  const nextCandles = candles.slice();
  if (found) nextCandles[low] = merged;
  else nextCandles.splice(low, 0, merged);
  if (nextCandles.length > limit) {
    nextCandles.splice(0, nextCandles.length - limit);
  }
  return nextCandles;
}

export function normalizeMarketTradeUpdate(value: unknown): MarketTradeUpdateEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const identity = normalizeMarketSubscription(source.address, source.chain);
  const transactionHash = String(source.transactionHash || '').toLowerCase();
  const walletAddress = String(source.walletAddress || '').toLowerCase();
  const blockTime = validTimestamp(source.blockTime);
  const actionIndex = Number(source.actionIndex);
  const blockNumber = Number(source.blockNumber);
  const side = String(source.side || '');
  const nullableNumber = (metric: unknown) => (
    metric == null || metric === '' ? null : Number(metric)
  );
  const amountUsd = nullableNumber(source.amountUsd);
  const priceUsd = nullableNumber(source.priceUsd);
  const mcUsd = nullableNumber(source.mcUsd);
  if (
    identity?.chain !== 'robinhood' || !blockTime
    || !/^0x[0-9a-f]{64}$/.test(transactionHash)
    || !/^0x[0-9a-f]{40}$/.test(walletAddress)
    || !Number.isSafeInteger(actionIndex) || actionIndex < 0
    || !Number.isSafeInteger(blockNumber) || blockNumber < 0
    || !['buy', 'sell'].includes(side)
    || ![amountUsd, priceUsd, mcUsd].every((metric) => metric == null || Number.isFinite(metric))
  ) return null;
  return {
    type: 'market:trade', chain: 'robinhood', address: identity.address,
    transactionHash, actionIndex, blockNumber, blockTime,
    side: side as 'buy' | 'sell', walletAddress, amountUsd, priceUsd, mcUsd,
  };
}

export function compareMarketEventSequence(left: unknown, right: unknown) {
  return String(left || '').localeCompare(String(right || ''));
}

export function shouldReplaceMarketCandleClose(
  existingSourceBucketTs: string,
  existingSequence: unknown,
  incomingSourceBucketTs: string,
  incomingSequence: unknown,
) {
  const sourceOrder = Date.parse(incomingSourceBucketTs) - Date.parse(existingSourceBucketTs);
  return sourceOrder === 0
    ? compareMarketEventSequence(incomingSequence, existingSequence) > 0
    : sourceOrder > 0;
}

function finiteMetric(value: unknown) {
  if (value == null || value === '') return null;
  const metric = Number(value);
  return Number.isFinite(metric) ? metric : null;
}

function nonNegativeMetric(value: unknown) {
  const metric = finiteMetric(value);
  return metric != null && metric >= 0 ? metric : null;
}

function activityDelta(current: number | null, previous: number | null, sameBucket: boolean) {
  if (current == null) return null;
  return sameBucket && previous != null ? Math.max(0, current - previous) : current;
}

function buildCanonicalVolume5mPatch(
  activity: MarketBucketUpdateEvent['activity'],
  previous: RealtimeActivityState,
) {
  const keys = [
    'currentVolume5mUsd', 'prevVolume5mCanonical', 'volume5mBaselineAt',
    'volume5mWindowEnd', 'volume5mDeltaCoverage',
  ];
  if (!activity || !keys.some((key) => Object.hasOwn(activity, key))) return null;
  const baselineAt = validTimestamp(activity.volume5mBaselineAt);
  const windowEnd = validTimestamp(activity.volume5mWindowEnd);
  const coverageValue = String(activity.volume5mDeltaCoverage || 'unavailable');
  const coverage = ['complete', 'partial', 'unavailable'].includes(coverageValue)
    ? coverageValue as 'complete' | 'partial' | 'unavailable'
    : 'unavailable';
  const sameWindow = windowEnd != null
    && windowEnd === validTimestamp(previous.volume5mWindowEnd);
  const resolvedBaselineAt = baselineAt
    ?? (sameWindow ? validTimestamp(previous.volume5mBaselineAt) : null);
  const hasCanonicalBounds = resolvedBaselineAt != null && windowEnd != null
    && Date.parse(windowEnd) - Date.parse(resolvedBaselineAt) === 5 * 60_000;
  const previousVolume = Object.hasOwn(activity, 'prevVolume5mCanonical')
    ? nonNegativeMetric(activity.prevVolume5mCanonical)
    : (sameWindow ? nonNegativeMetric(previous.prevVolume5mCanonical) : null);
  return {
    currentVolumeUsd: nonNegativeMetric(activity.currentVolume5mUsd),
    previousVolumeUsd: previousVolume,
    baselineAt: resolvedBaselineAt,
    windowEnd,
    coverage: hasCanonicalBounds ? coverage : 'unavailable' as const,
  };
}

export function buildRealtimeActivityPatch(
  event: MarketBucketUpdateEvent,
  previous: RealtimeActivityState = {},
) {
  const volumeUsd = nonNegativeMetric(event.activity?.volumeUsd);
  const rawSwaps = nonNegativeMetric(event.activity?.swaps);
  const swaps = rawSwaps != null ? Math.trunc(rawSwaps) : null;
  if (volumeUsd == null && swaps == null) return null;

  const previousBucketMs = Date.parse(previous.bucketTs || '');
  const bucketMs = Date.parse(event.bucketTs);
  if (Number.isFinite(previousBucketMs) && previousBucketMs > bucketMs) return null;
  const sameBucket = previousBucketMs === bucketMs;
  const includedThroughMs = Date.parse(previous.windowEnd || '');
  const bucketAlreadyIncluded = !sameBucket
    && Number.isFinite(includedThroughMs)
    && bucketMs < includedThroughMs;
  return {
    bucketTs: event.bucketTs,
    volumeUsd,
    swaps,
    volumeDeltaUsd: bucketAlreadyIncluded
      ? 0 : activityDelta(volumeUsd, nonNegativeMetric(previous.volumeUsd), sameBucket),
    swapsDelta: bucketAlreadyIncluded
      ? 0 : activityDelta(swaps, nonNegativeMetric(previous.swaps), sameBucket),
    canonicalVolume5m: buildCanonicalVolume5mPatch(event.activity, previous),
  };
}

export function buildLiveTokenChartCandle(event: MarketBucketUpdateEvent): LiveTokenChartCandle {
  const candle = event.candle;
  const valuationType = candle.valuationType === 'fdv' || event.valuation?.type === 'fdv'
    ? 'fdv'
    : 'market-cap';
  const price = (key: 'open' | 'high' | 'low' | 'close') => finiteMetric(
    candle[`${key}PriceUsd`] ?? candle[`${key}Price`],
  );
  return {
    bucketTs: candle.bucketTs,
    pairAddress: candle.pairAddress ?? event.pairAddress ?? null,
    granularityMinutes: candle.granularityMinutes,
    sourceGranularityMinutes: candle.granularityMinutes,
    valuationType,
    openMcap: finiteMetric(candle.openMcap),
    highMcap: finiteMetric(candle.highMcap),
    lowMcap: finiteMetric(candle.lowMcap),
    closeMcap: finiteMetric(candle.closeMcap),
    openFdvUsd: finiteMetric(candle.openFdvUsd),
    highFdvUsd: finiteMetric(candle.highFdvUsd),
    lowFdvUsd: finiteMetric(candle.lowFdvUsd),
    closeFdvUsd: finiteMetric(candle.closeFdvUsd),
    openPrice: price('open'),
    highPrice: price('high'),
    lowPrice: price('low'),
    closePrice: price('close'),
    openPriceUsd: price('open'),
    highPriceUsd: price('high'),
    lowPriceUsd: price('low'),
    closePriceUsd: price('close'),
    sampleCount: Math.max(0, Math.trunc(finiteMetric(candle.sampleCount) ?? 0)),
    liveSourceBucketTs: event.bucketTs,
    liveSequence: event.sequence,
  };
}

function normalizeRealtimeValuation(value: MarketBucketUpdateEvent['valuation']) {
  if (value?.type === 'fdv') {
    return { type: 'fdv' as const, usd: finiteMetric(value.fdvUsd) };
  }
  if (value?.type === 'mcap') {
    return { type: 'mcap' as const, usd: finiteMetric(value.mcapUsd) };
  }
  return { type: null, usd: null };
}

function buildRealtimeRollingVolumes(event: MarketBucketUpdateEvent) {
  const mappings = [
    ['volume5mUsd', 'volume5m'],
    ['volume1hUsd', 'volume1h'],
    ['volume6hUsd', 'volume6h'],
    ['volume24hUsd', 'volume24h'],
  ] as const;
  const values: NonNullable<RealtimeTokenMarketPatch['rollingVolumes']> = {};
  const coverage: NonNullable<RealtimeTokenMarketPatch['volumeCoverage']> = {};
  for (const [sourceKey, targetKey] of mappings) {
    const value = nonNegativeMetric(event.activity?.[sourceKey]);
    if (value != null) values[targetKey] = value;
    const window = targetKey.slice('volume'.length) as keyof typeof coverage;
    const coverageValue = String(event.coverage?.[window] || '');
    if (coverageValue === 'complete' || coverageValue === 'partial' || coverageValue === 'unavailable') {
      coverage[window] = coverageValue;
    }
  }
  return {
    values: Object.keys(values).length > 0 ? values : null,
    coverage: Object.keys(coverage).length > 0 ? coverage : null,
  };
}

export function buildRealtimeTokenMarketPatch(
  event: MarketBucketUpdateEvent,
  previousActivity: RealtimeActivityState = {},
) {
  const valuation = event.valuation;
  const normalizedValuation = normalizeRealtimeValuation(valuation);
  const valuationType = normalizedValuation.type;
  const valuationUsd = normalizedValuation.usd;
  const applicableValuationType = valuationUsd == null ? null : valuationType;
  const observedAt = validTimestamp(valuation?.observedAt) || event.bucketTs;
  const activity = buildRealtimeActivityPatch(event, previousActivity);
  const rolling = buildRealtimeRollingVolumes(event);
  const patch: RealtimeTokenMarketPatch = {
    observedAt,
    priceUsd: finiteMetric(valuation?.priceUsd),
    activityState: 'fresh' as const,
    valuationType: applicableValuationType === 'mcap' ? 'market-cap' : applicableValuationType,
    valuation: applicableValuationType && valuationUsd != null
      ? { type: applicableValuationType, usd: valuationUsd, observedAt, freshness: 'fresh' }
      : null,
    fdv: applicableValuationType === 'fdv' ? valuationUsd : null,
    mcap: applicableValuationType === 'mcap' ? valuationUsd : null,
    rollingVolumes: rolling.values,
    volumeCoverage: rolling.coverage,
    activity,
  };
  return patch.valuation || patch.priceUsd != null || patch.activity || patch.rollingVolumes ? patch : null;
}

export function createMarketEventOrderGate(maxEntries = 4096) {
  const limit = Math.max(1, Math.trunc(maxEntries));
  const sequences = new Map<string, string>();

  function accept(event: MarketBucketUpdateEvent) {
    const identity = createTokenIdentity(event.chain, event.address);
    const key = `${identity.key}:${event.bucketTs}`;
    const current = sequences.get(key);
    if (current && compareMarketEventSequence(event.sequence, current) <= 0) {
      return false;
    }
    sequences.set(key, event.sequence);
    while (sequences.size > limit) {
      const oldest = sequences.keys().next().value;
      if (typeof oldest !== 'string') break;
      sequences.delete(oldest);
    }
    return true;
  }

  function clearIdentity(identity: MarketSubscriptionIdentity) {
    const prefix = `${createTokenIdentity(identity.chain, identity.address).key}:`;
    for (const key of sequences.keys()) {
      if (key.startsWith(prefix)) sequences.delete(key);
    }
  }

  return Object.freeze({ accept, clear: () => sequences.clear(), clearIdentity });
}
