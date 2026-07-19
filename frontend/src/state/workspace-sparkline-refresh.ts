import type { TokenChain } from '../utils/token-chain';

const DAY_MS = 24 * 60 * 60 * 1000;

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

export function resolveWorkspaceSparklineGranularityMinutes(input: {
  anchorAt?: number | null;
  rangeDays: number;
  referenceTs?: number;
}) {
  const referenceTs = Number.isFinite(Number(input.referenceTs))
    ? Number(input.referenceTs)
    : Date.now();
  const rangeMs = Math.max(1, Number(input.rangeDays) || 1) * DAY_MS;
  const anchorAt = Number(input.anchorAt);
  const tokenAgeMs = Number.isFinite(anchorAt) && anchorAt > 0 && anchorAt <= referenceTs
    ? Math.max(0, referenceTs - anchorAt)
    : rangeMs;
  const effectiveSpanMs = Math.min(rangeMs, tokenAgeMs);
  if (effectiveSpanMs <= DAY_MS) return 1;
  if (effectiveSpanMs <= 3 * DAY_MS) return 5;
  if (effectiveSpanMs <= 11 * DAY_MS) return 15;
  return 30;
}

export function splitWorkspaceSparklineBatchesByChain(
  batches: WorkspaceIdentitySparklineBatch[],
) {
  return batches.flatMap((batch) => {
    const identitiesByChain = new Map<TokenChain, WorkspaceSparklineIdentity[]>();
    for (const identity of batch.identities) {
      const identities = identitiesByChain.get(identity.chain) || [];
      identities.push(identity);
      identitiesByChain.set(identity.chain, identities);
    }
    return [...identitiesByChain.values()].map((identities) => ({ ...batch, identities }));
  });
}

export async function runWorkspaceSparklineRequestWithTimeout<T>(
  timeoutMs: number,
  request: (signal: AbortSignal) => Promise<T>,
) {
  const controller = new AbortController();
  const safeTimeoutMs = Math.max(1, Math.floor(Number(timeoutMs) || 1));
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await new Promise<T>((resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error(`Workspace sparkline request timed out after ${safeTimeoutMs}ms`));
      }, safeTimeoutMs);
      void request(controller.signal).then(resolve, reject);
    });
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

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
