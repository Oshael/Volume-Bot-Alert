export type WorkspaceSparklineBatch = {
  hours: number;
  granularityMinutes: number;
  addresses: string[];
};

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

export function selectWorkspaceSparklineRefreshBatches(
  batches: WorkspaceSparklineBatch[],
  cache: Record<string, WorkspaceSparklineCacheValue>,
  options: { force?: boolean; now: number; refreshIntervalMs: number },
) {
  return batches
    .map((batch) => ({
      ...batch,
      addresses: options.force
        ? batch.addresses.slice()
        : batch.addresses.filter((address) => !isWorkspaceSparklineEntryFresh(
          cache[address],
          batch,
          options.now,
          options.refreshIntervalMs,
        )),
    }))
    .filter((batch) => batch.addresses.length > 0);
}

export function getWorkspaceSparklineNextRefreshAt(
  batches: WorkspaceSparklineBatch[],
  cache: Record<string, WorkspaceSparklineCacheValue>,
  refreshIntervalMs: number,
) {
  let nextRefreshAt = Number.POSITIVE_INFINITY;

  for (const batch of batches) {
    for (const address of batch.addresses) {
      const entry = cache[address];
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
