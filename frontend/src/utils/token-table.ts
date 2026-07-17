import type { BucketSortCriterion, BucketSortMode, BucketSortWindow, ManualTokenEntry, MonitoredSortCriterion, MonitoredSortMode, MonitoredSortWindow } from '../state/app-state';
import { buildTokenIdentityKey } from './token-chain';

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
    if (options.starredOnly && !starredSet.has(buildTokenIdentityKey(item.chain || 'solana', item.address))) {
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

function getMonitoredMetric(item: ManualTokenEntry, mode: MonitoredSortMode, window: MonitoredSortWindow) {
  if (mode === 'age') return item.createdAt || 0;
  if (mode === 'mcap') return item.mcap || 0;
  if (window === '1h') return item.volume1h || 0;
  if (window === '6h') return item.volume6h || 0;
  if (window === '24h') return item.volume24h || 0;
  return item.volume5m || 0;
}

function compareMonitoredCriterion(a: ManualTokenEntry, b: ManualTokenEntry, criterion: MonitoredSortCriterion) {
  const aMetric = getMonitoredMetric(a, criterion.mode, criterion.window);
  const bMetric = getMonitoredMetric(b, criterion.mode, criterion.window);
  if ((criterion.mode === 'age' && criterion.window === 'oldest') || (criterion.mode === 'mcap' && criterion.window === 'lowest')) {
    return aMetric - bMetric;
  }
  return bMetric - aMetric;
}

function isVisibleMonitoredTableToken(item: ManualTokenEntry) {
  if (item._userManual || item._isPinnedMonitored) {
    return true;
  }

  const mcap = item.mcap ?? 0;
  return !(mcap > 0 && mcap < 30000);
}

function matchesTokenSearch(item: ManualTokenEntry, searchQuery: string) {
  if (!searchQuery) {
    return true;
  }

  const symbol = String(item.symbol || item.label || '').toLowerCase();
  const name = String(item.name || '').toLowerCase();
  const address = String(item.address || '').toLowerCase();
  return symbol.includes(searchQuery) || name.includes(searchQuery) || address.includes(searchQuery);
}

export function sortMonitoredTokens(tokens: ManualTokenEntry[], criteria: MonitoredSortCriterion[]) {
  return [...tokens].sort((a, b) => {
    for (const criterion of criteria) {
      const delta = compareMonitoredCriterion(a, b, criterion);
      if (delta !== 0) return delta;
    }
    const createdDelta = (b.createdAt || 0) - (a.createdAt || 0);
    if (createdDelta !== 0) return createdDelta;
    return (b.mcap || 0) - (a.mcap || 0);
  });
}

export function resolveMonitoredTableRows(
  tokens: ManualTokenEntry[],
  options: {
    searchQuery?: string;
    sortCriteria?: MonitoredSortCriterion[];
  } = {},
) {
  const searchQuery = String(options.searchQuery || '').trim().toLowerCase();
  const filtered = tokens.filter((item) => isVisibleMonitoredTableToken(item) && matchesTokenSearch(item, searchQuery));
  const regularTokens = sortMonitoredTokens(
    filtered.filter((item) => !item._isPinnedMonitored),
    options.sortCriteria || [{ mode: 'vol', window: '5m' }],
  );
  const pinnedTokens = filtered
    .filter((item) => item._isPinnedMonitored)
    .sort((a, b) => (a.pinnedSortOrder ?? 0) - (b.pinnedSortOrder ?? 0) || a.address.localeCompare(b.address));

  for (const item of pinnedTokens) {
    const position = Math.min(Math.max(0, item.pinnedSortOrder ?? 0), regularTokens.length);
    regularTokens.splice(position, 0, item);
  }
  return regularTokens;
}
