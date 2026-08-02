import type { TokenChain } from '../utils/token-chain';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MAX_TIMED_SPARKLINE_HOURS = 30 * 24;

export type WorkspaceSparklineIdentity = {
  chain: TokenChain;
  address: string;
  key: string;
};

export type WorkspaceIdentitySparklineBatch = {
  hours: number;
  granularityMinutes: number;
  allAvailable?: boolean;
  queryAllAvailable?: boolean;
  identities: WorkspaceSparklineIdentity[];
};

export type LegacyWorkspaceSparklineBatch = {
  hours: number;
  granularityMinutes: number;
  allAvailable?: boolean;
  queryAllAvailable?: boolean;
  addresses: string[];
};

export type WorkspaceSparklineBatch = WorkspaceIdentitySparklineBatch | LegacyWorkspaceSparklineBatch;

export type WorkspaceSparklineCacheValue = {
  generatedAt?: string | null;
  granularityMinutes?: number | null;
  hours?: number;
  allAvailable?: boolean;
  refreshedAt?: number;
};

export type WorkspaceSparklineMergeValue = WorkspaceSparklineCacheValue & {
  valuationType?: 'market-cap' | 'fdv' | null;
  bucketCount?: number;
  latestBucketAt?: string | null;
  points?: number;
  series?: unknown[];
  candles?: Array<{
    bucketTs: string;
    liveSequence?: string | null;
    closeMcap?: number | null;
    closeFdvUsd?: number | null;
  }>;
  loading?: boolean;
};

function hasRenderableSeries(entry?: WorkspaceSparklineMergeValue | null) {
  return Array.isArray(entry?.series) && entry.series.length >= 2;
}

function hasSameRequestShape(
  previous: WorkspaceSparklineMergeValue,
  incoming: WorkspaceSparklineMergeValue,
) {
  return Number(previous.hours) === Number(incoming.hours)
    && Number(previous.granularityMinutes) === Number(incoming.granularityMinutes)
    && (previous.allAvailable === true) === (incoming.allAvailable === true);
}

export function mergeWorkspaceSparklineRefreshEntry<T extends WorkspaceSparklineMergeValue>(
  previous: T | null | undefined,
  incoming: T,
): T {
  if (
    !previous
    || !hasRenderableSeries(previous)
    || hasRenderableSeries(incoming)
    || !hasSameRequestShape(previous, incoming)
  ) {
    return incoming;
  }

  return {
    ...previous,
    refreshedAt: incoming.refreshedAt,
    loading: false,
  } as T;
}

function parseTimestamp(value: unknown) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function getSnapshotBoundaryMs(entry: WorkspaceSparklineMergeValue) {
  const generatedAt = parseTimestamp(entry.generatedAt);
  if (generatedAt == null) return null;
  const granularityMs = Math.max(1, Number(entry.granularityMinutes) || 1) * 60 * 1000;
  return Math.floor(generatedAt / granularityMs) * granularityMs;
}

function getCandleSeriesValue(
  candle: NonNullable<WorkspaceSparklineMergeValue['candles']>[number],
  valuationType: WorkspaceSparklineMergeValue['valuationType'],
) {
  const value = valuationType === 'fdv' ? candle.closeFdvUsd : candle.closeMcap;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function mergeWorkspaceSparklineSnapshotEntry<T extends WorkspaceSparklineMergeValue>(
  previous: T | null | undefined,
  incoming: T,
): T {
  const emptySafeEntry = mergeWorkspaceSparklineRefreshEntry(previous, incoming);
  if (emptySafeEntry !== incoming || !previous || !hasSameRequestShape(previous, incoming)) {
    return emptySafeEntry;
  }

  const previousGeneratedAt = parseTimestamp(previous.generatedAt);
  const incomingGeneratedAt = parseTimestamp(incoming.generatedAt);
  const boundaryMs = getSnapshotBoundaryMs(incoming);
  if (
    previousGeneratedAt == null
    || incomingGeneratedAt == null
    || previousGeneratedAt <= incomingGeneratedAt
    || boundaryMs == null
    || !Array.isArray(previous.candles)
    || !Array.isArray(incoming.candles)
  ) {
    return incoming;
  }

  const liveCandles = previous.candles.filter((candle) => (
    Boolean(String(candle.liveSequence || '').trim())
    && (parseTimestamp(candle.bucketTs) ?? -1) >= boundaryMs
  ));
  if (liveCandles.length === 0) return incoming;

  const candlesByTimestamp = new Map(incoming.candles.map((candle) => [candle.bucketTs, candle]));
  for (const candle of liveCandles) candlesByTimestamp.set(candle.bucketTs, candle);
  const maxCandles = Math.max(1, Number(incoming.points) || incoming.candles.length);
  const candles = [...candlesByTimestamp.values()]
    .sort((left, right) => (parseTimestamp(left.bucketTs) ?? 0) - (parseTimestamp(right.bucketTs) ?? 0))
    .slice(-maxCandles);
  const valuationType = incoming.valuationType ?? previous.valuationType;
  const series = candles
    .map((candle) => getCandleSeriesValue(candle, valuationType))
    .filter((value): value is number => value != null);

  return {
    ...incoming,
    valuationType,
    generatedAt: previous.generatedAt,
    latestBucketAt: candles.at(-1)?.bucketTs ?? incoming.latestBucketAt,
    bucketCount: candles.length,
    series: series.length >= 2 ? series : incoming.series,
    candles,
    loading: false,
  } as T;
}

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

export function resolveWorkspaceSparklineRequestShape(input: {
  anchorAt?: number | null;
  requestedHours: number;
  allAvailable?: boolean;
  referenceTs?: number;
}) {
  const referenceTs = Number.isFinite(Number(input.referenceTs))
    ? Number(input.referenceTs)
    : Date.now();
  const anchorAt = Number(input.anchorAt);
  const hasReliableAge = Number.isFinite(anchorAt) && anchorAt > 0 && anchorAt <= referenceTs;
  const tokenAgeHours = hasReliableAge
    ? Math.max(1, Math.ceil((referenceTs - anchorAt) / HOUR_MS))
    : null;
  const allAvailable = input.allAvailable === true;
  const queryAllAvailable = allAvailable
    && (tokenAgeHours == null || tokenAgeHours > MAX_TIMED_SPARKLINE_HOURS);
  const requestedHours = Math.max(
    1,
    Math.min(Math.ceil(Number(input.requestedHours) || 1), MAX_TIMED_SPARKLINE_HOURS),
  );
  const hours = queryAllAvailable ? 0 : (allAvailable ? tokenAgeHours ?? requestedHours : requestedHours);
  const granularityMinutes = queryAllAvailable
    ? 60
    : resolveWorkspaceSparklineGranularityMinutes({
      anchorAt: hasReliableAge ? anchorAt : null,
      rangeDays: hours / 24,
      referenceTs,
    });

  return { hours, granularityMinutes, allAvailable, queryAllAvailable };
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
  if (
    Number(entry.hours) !== batch.hours
    || Number(entry.granularityMinutes) !== batch.granularityMinutes
    || (entry.allAvailable === true) !== (batch.allAvailable === true)
  ) {
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
        || (entry.allAvailable === true) !== (batch.allAvailable === true)
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
