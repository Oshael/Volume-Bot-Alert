import type { TokenChain } from '../utils/token-chain';

export const DEFAULT_EXPANDED_SPARKLINE_POINTS = 720;
export const ROBINHOOD_FULL_HISTORY_SPARKLINE_POINTS = 10_000;
export const ROBINHOOD_ONE_MINUTE_SPARKLINE_POINTS = 10_000;

const ROBINHOOD_FULL_HISTORY_GRANULARITIES = new Set([5, 15, 30]);

export function resolveExpandedSparklineRequestShape(
  chain: TokenChain,
  granularityMinutes: number,
) {
  const allAvailable = chain === 'robinhood'
    && ROBINHOOD_FULL_HISTORY_GRANULARITIES.has(granularityMinutes);
  let points = allAvailable
    ? ROBINHOOD_FULL_HISTORY_SPARKLINE_POINTS
    : DEFAULT_EXPANDED_SPARKLINE_POINTS;
  if (chain === 'robinhood' && granularityMinutes === 1) {
    points = ROBINHOOD_ONE_MINUTE_SPARKLINE_POINTS;
  }
  return Object.freeze({
    allAvailable,
    points,
  });
}
