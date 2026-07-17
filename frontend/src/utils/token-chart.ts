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

export function getTokenChartValuationLabel(sparkline: Pick<TokenSparklineEntry, 'valuationType'>) {
  return resolveTokenChartValuationType(sparkline) === 'fdv' ? 'FDV' : 'MCAP';
}
