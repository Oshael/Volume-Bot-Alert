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

export function buildRealtimeTokenMarketPatch(event: MarketBucketUpdateEvent) {
  const valuation = event.valuation;
  const normalizedValuation = normalizeRealtimeValuation(valuation);
  const valuationType = normalizedValuation.type;
  const valuationUsd = normalizedValuation.usd;
  const applicableValuationType = valuationUsd == null ? null : valuationType;
  const observedAt = validTimestamp(valuation?.observedAt) || event.bucketTs;
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
  };
  return patch.valuation || patch.priceUsd != null || event.activity ? patch : null;
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
