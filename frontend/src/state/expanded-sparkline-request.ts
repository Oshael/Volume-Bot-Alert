import type { TokenChain } from '../utils/token-chain';

export const DEFAULT_EXPANDED_SPARKLINE_POINTS = 720;
export const ROBINHOOD_FULL_HISTORY_SPARKLINE_POINTS = 10_000;

const ROBINHOOD_FULL_HISTORY_GRANULARITIES = new Set([5, 15, 30]);

export function resolveExpandedSparklineRequestShape(
  chain: TokenChain,
  granularityMinutes: number,
) {
  const allAvailable = chain === 'robinhood'
    && ROBINHOOD_FULL_HISTORY_GRANULARITIES.has(granularityMinutes);
  return Object.freeze({
    allAvailable,
    points: allAvailable
      ? ROBINHOOD_FULL_HISTORY_SPARKLINE_POINTS
      : DEFAULT_EXPANDED_SPARKLINE_POINTS,
  });
}
