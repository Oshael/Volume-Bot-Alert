import type { TokenChain } from '../utils/token-chain';

export type WorkspaceSparklineIdentity = {
  chain: TokenChain;
  address: string;
  key: string;
};

export type WorkspaceIdentitySparklineBatch = {
  hours: number;
  granularityMinutes: number;
  identities: WorkspaceSparklineIdentity[];
};

export type LegacyWorkspaceSparklineBatch = {
  hours: number;
  granularityMinutes: number;
  addresses: string[];
};

export type WorkspaceSparklineBatch = WorkspaceIdentitySparklineBatch | LegacyWorkspaceSparklineBatch;

export type WorkspaceSparklineCacheValue = {
  generatedAt?: string | null;
  granularityMinutes?: number | null;
  hours?: number;
  refreshedAt?: number;
};

function getWorkspaceSparklineRefreshAt(entry?: WorkspaceSparklineCacheValue | null) {
  const refreshedAt = Number(entry?.refreshedAt);
  if (Number.isFinite(refreshedAt) && refreshedAt > 0) {
    return refreshedAt;
  }

  const generatedAt = Date.parse(String(entry?.generatedAt || ''));
  return Number.isFinite(generatedAt) ? generatedAt : 0;
}

function isWorkspaceSparklineEntryFresh(
  entry: WorkspaceSparklineCacheValue | null | undefined,
  batch: WorkspaceSparklineBatch,
  now: number,
  refreshIntervalMs: number,
) {
  if (!entry) {
    return false;
  }
  if (Number(entry.hours) !== batch.hours || Number(entry.granularityMinutes) !== batch.granularityMinutes) {
    return false;
  }

  const refreshedAt = getWorkspaceSparklineRefreshAt(entry);
  return refreshedAt > 0 && refreshedAt + refreshIntervalMs > now;
}

function getBatchCacheKeys(batch: WorkspaceSparklineBatch) {
  return 'identities' in batch
    ? batch.identities.map((identity) => identity.key)
    : batch.addresses;
}

function filterBatchCacheKeys(
  batch: WorkspaceSparklineBatch,
  shouldInclude: (cacheKey: string) => boolean,
): WorkspaceSparklineBatch {
  if ('identities' in batch) {
    return { ...batch, identities: batch.identities.filter((identity) => shouldInclude(identity.key)) };
  }
  return { ...batch, addresses: batch.addresses.filter(shouldInclude) };
}

export function selectWorkspaceSparklineRefreshBatches(
  batches: WorkspaceIdentitySparklineBatch[],
  cache: Record<string, WorkspaceSparklineCacheValue>,
  options: { force?: boolean; now: number; refreshIntervalMs: number },
): WorkspaceIdentitySparklineBatch[];
export function selectWorkspaceSparklineRefreshBatches(
  batches: LegacyWorkspaceSparklineBatch[],
  cache: Record<string, WorkspaceSparklineCacheValue>,
  options: { force?: boolean; now: number; refreshIntervalMs: number },
): LegacyWorkspaceSparklineBatch[];
export function selectWorkspaceSparklineRefreshBatches(
  batches: WorkspaceSparklineBatch[],
  cache: Record<string, WorkspaceSparklineCacheValue>,
  options: { force?: boolean; now: number; refreshIntervalMs: number },
): WorkspaceSparklineBatch[] {
  return batches
    .map((batch) => filterBatchCacheKeys(
      batch,
      (cacheKey) => options.force || !isWorkspaceSparklineEntryFresh(
        cache[cacheKey],
        batch,
        options.now,
        options.refreshIntervalMs,
      ),
    ))
    .filter((batch) => getBatchCacheKeys(batch).length > 0);
}

export function getWorkspaceSparklineNextRefreshAt(
  batches: WorkspaceSparklineBatch[],
  cache: Record<string, WorkspaceSparklineCacheValue>,
  refreshIntervalMs: number,
) {
  let nextRefreshAt = Number.POSITIVE_INFINITY;

  for (const batch of batches) {
    for (const cacheKey of getBatchCacheKeys(batch)) {
      const entry = cache[cacheKey];
      if (
        !entry
        || Number(entry.hours) !== batch.hours
        || Number(entry.granularityMinutes) !== batch.granularityMinutes
      ) {
        return 0;
      }

      const refreshedAt = getWorkspaceSparklineRefreshAt(entry);
      if (!(refreshedAt > 0)) {
        return 0;
      }
      nextRefreshAt = Math.min(nextRefreshAt, refreshedAt + refreshIntervalMs);
    }
  }

  return Number.isFinite(nextRefreshAt) ? nextRefreshAt : 0;
}
