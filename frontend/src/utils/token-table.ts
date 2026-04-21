import type { BucketSortCriterion, BucketSortMode, BucketSortWindow, ManualTokenEntry } from '../state/app-state';

function getBucketMetric(item: ManualTokenEntry, mode: BucketSortMode, window: BucketSortWindow) {
  if (mode === 'age') return item.createdAt || 0;
  if (mode === 'mcap') return item.mcap || 0;
  if (mode === 'pchange') {
    if (window === '1h') return item.priceChange1h || 0;
    if (window === '6h') return item.priceChange6h || 0;
    return item.priceChange24h || 0;
  }
  if (window === '1h') return item.volume1h || 0;
  if (window === '6h') return item.volume6h || 0;
  return item.volume24h || 0;
}

function compareBucketCriterion(a: ManualTokenEntry, b: ManualTokenEntry, criterion: BucketSortCriterion) {
  const aMetric = getBucketMetric(a, criterion.mode, criterion.window);
  const bMetric = getBucketMetric(b, criterion.mode, criterion.window);
  if ((criterion.mode === 'age' && criterion.window === 'oldest') || (criterion.mode === 'mcap' && criterion.window === 'lowest')) {
    return aMetric - bMetric;
  }
  return bMetric - aMetric;
}

export function sortBucketTokens(tokens: ManualTokenEntry[], criteria: BucketSortCriterion[]) {
  return [...tokens].sort((a, b) => {
    for (const criterion of criteria) {
      const delta = compareBucketCriterion(a, b, criterion);
      if (delta !== 0) return delta;
    }
    const createdDelta = (b.createdAt || 0) - (a.createdAt || 0);
    if (createdDelta !== 0) return createdDelta;
    return (b.mcap || 0) - (a.mcap || 0);
  });
}

export function filterManualTableTokens(
  tokens: ManualTokenEntry[],
  options: {
    starredOnly?: boolean;
    starredTokens?: string[];
    searchQuery?: string;
  } = {},
) {
  const searchQuery = String(options.searchQuery || '').trim().toLowerCase();
  const starredSet = new Set(Array.isArray(options.starredTokens) ? options.starredTokens : []);

  return tokens.filter((item) => {
    if (options.starredOnly && !starredSet.has(item.address)) {
      return false;
    }
    if (!searchQuery) {
      return true;
    }

    const symbol = String(item.symbol || item.label || '').toLowerCase();
    const name = String(item.name || '').toLowerCase();
    const address = String(item.address || '').toLowerCase();
    return symbol.includes(searchQuery) || name.includes(searchQuery) || address.includes(searchQuery);
  });
}

export function resolveManualTableRows(
  tokens: ManualTokenEntry[],
  options: {
    starredOnly?: boolean;
    starredTokens?: string[];
    searchQuery?: string;
    sortCriteria?: BucketSortCriterion[];
  } = {},
) {
  const filtered = filterManualTableTokens(tokens, options);
  return sortBucketTokens(filtered, options.sortCriteria || [{ mode: 'mcap', window: 'highest' }]);
}
