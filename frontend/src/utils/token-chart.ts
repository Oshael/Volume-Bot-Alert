import type {
  TokenSparklineCandleEntry,
  TokenSparklineEntry,
} from '../state/app-state';
import type { TokenValuationType } from './token-valuation';

export type NormalizedTokenChartCandle = {
  bucketTs: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

const GAP_FILL_GRANULARITIES = new Set([1, 5, 15, 30, 60]);
const MAX_GAP_FILLED_CANDLES = 25_000;
const SYNTHETIC_CANDLE_BODY_RATIO = 0.001;

function toFiniteChartNumber(value: unknown) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function resolveTokenChartValuationType(
  sparkline: Pick<TokenSparklineEntry, 'valuationType'>,
  candle?: Pick<TokenSparklineCandleEntry, 'valuationType'> | null,
): TokenValuationType {
  return candle?.valuationType === 'fdv' || candle?.valuationType === 'market-cap'
    ? candle.valuationType
    : sparkline.valuationType === 'fdv' ? 'fdv' : 'market-cap';
}

export function normalizeTokenChartCandle(
  candle: TokenSparklineCandleEntry,
  valuationType: TokenValuationType,
): NormalizedTokenChartCandle | null {
  const usesFdv = candle.valuationType === 'fdv'
    || (candle.valuationType !== 'market-cap' && valuationType === 'fdv');
  const close = toFiniteChartNumber(usesFdv ? candle.closeFdvUsd : candle.closeMcap);
  const bucketTs = typeof candle.bucketTs === 'string' ? candle.bucketTs : '';
  if (close == null || !bucketTs) {
    return null;
  }

  const open = toFiniteChartNumber(usesFdv ? candle.openFdvUsd : candle.openMcap) ?? close;
  const high = Math.max(
    toFiniteChartNumber(usesFdv ? candle.highFdvUsd : candle.highMcap) ?? close,
    open,
    close,
  );
  const low = Math.min(
    toFiniteChartNumber(usesFdv ? candle.lowFdvUsd : candle.lowMcap) ?? close,
    open,
    close,
  );
  return { bucketTs, open, high, low, close };
}

export function normalizeTokenChartCandles(sparkline: TokenSparklineEntry) {
  if (!Array.isArray(sparkline.candles)) {
    return [];
  }
  return sparkline.candles
    .map((candle) => normalizeTokenChartCandle(
      candle,
      resolveTokenChartValuationType(sparkline, candle),
    ))
    .filter((candle): candle is NormalizedTokenChartCandle => Boolean(candle));
}

export function fillTokenChartCandleGaps(
  candles: NormalizedTokenChartCandle[],
  granularityMinutes: unknown,
) {
  const safeGranularity = Math.round(Number(granularityMinutes));
  const sorted = [...candles].sort(
    (left, right) => Date.parse(left.bucketTs) - Date.parse(right.bucketTs),
  );
  if (!GAP_FILL_GRANULARITIES.has(safeGranularity) || sorted.length < 2) {
    return sorted;
  }

  const bucketMs = safeGranularity * 60_000;
  const firstMs = Date.parse(sorted[0].bucketTs);
  const lastMs = Date.parse(sorted[sorted.length - 1].bucketTs);
  const denseLength = Math.floor((lastMs - firstMs) / bucketMs) + 1;
  if (!Number.isFinite(denseLength) || denseLength > MAX_GAP_FILLED_CANDLES) {
    return sorted;
  }

  const filled: NormalizedTokenChartCandle[] = [sorted[0]];
  for (const candle of sorted.slice(1)) {
    const previous = filled[filled.length - 1];
    const previousMs = Date.parse(previous.bucketTs);
    const currentMs = Date.parse(candle.bucketTs);
    const gapMs = currentMs - previousMs;
    if (gapMs > bucketMs && gapMs % bucketMs === 0) {
      const syntheticClose = previous.close;
      const syntheticBody = Math.max(
        Math.abs(syntheticClose) * SYNTHETIC_CANDLE_BODY_RATIO,
        Number.EPSILON,
      );
      const syntheticOpen = previous.close >= previous.open
        ? syntheticClose - syntheticBody
        : syntheticClose + syntheticBody;
      for (let timestamp = previousMs + bucketMs; timestamp < currentMs; timestamp += bucketMs) {
        filled.push({
          bucketTs: new Date(timestamp).toISOString(),
          open: syntheticOpen,
          high: Math.max(syntheticOpen, syntheticClose),
          low: Math.min(syntheticOpen, syntheticClose),
          close: syntheticClose,
        });
      }
    }
    filled.push(candle);
  }
  return filled;
}

export function buildTokenChartViewportKey(
  identityKey: string,
  granularityMinutes: unknown,
) {
  const safeGranularity = Math.max(1, Math.round(Number(granularityMinutes) || 1));
  return `${identityKey}::${safeGranularity}`;
}

export function getTokenChartValuationLabel(sparkline: Pick<TokenSparklineEntry, 'valuationType'>) {
  return resolveTokenChartValuationType(sparkline) === 'fdv' ? 'FDV' : 'MCAP';
}
