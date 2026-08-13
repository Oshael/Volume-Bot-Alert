import type { ApiResponseMetadata } from '../services/api/response-metadata';

export type SparklineDiagnosticIdentity = {
  key: string;
  chain: string;
  address: string;
};

export type SparklineDiagnosticReturnedItem = {
  key: string;
  seriesPoints: number;
  bucketCount: number | null;
};

export type SparklineDiagnosticBatchObservation = {
  startedAt: number;
  headersAt: number | null;
  completedAt: number | null;
  hours: number;
  granularityMinutes: number;
  allAvailable: boolean;
  queryAllAvailable: boolean;
  identities: SparklineDiagnosticIdentity[];
  response: ApiResponseMetadata | null;
  returned: SparklineDiagnosticReturnedItem[];
  error: string | null;
};

export type SparklineDiagnosticCacheEntry = {
  loading: boolean;
  seriesPoints: number;
  bucketCount: number | null;
  firstBucketAt: string | null;
  latestBucketAt: string | null;
  refreshedAt: number | null;
};

export type SparklineDiagnosticReport = ReturnType<typeof buildSparklineDiagnosticReport>;

function roundMs(value: number | null) {
  return value == null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10;
}

export function parseSparklineServerTiming(value: string | null | undefined) {
  const timings: Record<string, number> = {};
  for (const part of String(value || '').split(',')) {
    const match = part.trim().match(/^([^;\s]+)(?:;[^,]*?dur=([0-9.]+))?/i);
    if (!match?.[1] || match[2] == null) continue;
    const duration = Number(match[2]);
    if (Number.isFinite(duration)) timings[match[1]] = duration;
  }
  return timings;
}

function buildBatchReport(batch: SparklineDiagnosticBatchObservation, index: number) {
  const returnedByKey = new Map(batch.returned.map((item) => [item.key, item]));
  const requestedKeys = batch.identities.map((identity) => identity.key);
  const missing = requestedKeys.filter((key) => !returnedByKey.has(key));
  const emptySeries = batch.returned
    .filter((item) => item.seriesPoints < 2)
    .map((item) => item.key);
  return {
    index,
    shape: {
      hours: batch.hours,
      granularityMinutes: batch.granularityMinutes,
      allAvailable: batch.allAvailable,
      queryAllAvailable: batch.queryAllAvailable,
    },
    timing: {
      headersMs: roundMs(batch.headersAt == null ? null : batch.headersAt - batch.startedAt),
      totalMs: roundMs(batch.completedAt == null ? null : batch.completedAt - batch.startedAt),
      backend: parseSparklineServerTiming(batch.response?.serverTiming),
    },
    response: batch.response,
    counts: {
      requested: requestedKeys.length,
      returned: batch.returned.length,
      missing: missing.length,
      emptySeries: emptySeries.length,
    },
    requested: batch.identities,
    returned: batch.returned,
    missing,
    emptySeries,
    error: batch.error,
  };
}

export function buildSparklineDiagnosticReport(input: {
  startedAt: number;
  completedAt: number;
  batches: SparklineDiagnosticBatchObservation[];
  cacheByIdentity: Record<string, SparklineDiagnosticCacheEntry | undefined>;
}) {
  const batches = input.batches.map(buildBatchReport);
  const tokenRequests = batches.flatMap((batch) => {
    const returnedByKey = new Map(batch.returned.map((item) => [item.key, item]));
    return batch.requested.map((identity) => {
      const returned = returnedByKey.get(identity.key);
      const cache = input.cacheByIdentity[identity.key] || null;
      const status = batch.error
        ? 'error'
        : !returned
          ? 'missing'
          : returned.seriesPoints < 2
            ? 'empty-series'
            : cache?.loading
              ? 'loading'
              : 'ready';
      return {
        batchIndex: batch.index,
        ...identity,
        status,
        batchTotalMs: batch.timing.totalMs,
        returned: returned || null,
        cache,
      };
    });
  });
  const statusCounts = tokenRequests.reduce<Record<string, number>>((counts, token) => {
    counts[token.status] = (counts[token.status] || 0) + 1;
    return counts;
  }, {});
  const totalDurations = batches
    .map((batch) => batch.timing.totalMs)
    .filter((value): value is number => value != null);
  return {
    generatedAt: new Date(input.completedAt).toISOString(),
    durationMs: roundMs(input.completedAt - input.startedAt),
    summary: {
      batches: batches.length,
      uniqueTokens: new Set(tokenRequests.map((token) => token.key)).size,
      tokenRequests: tokenRequests.length,
      statusCounts,
      slowestBatchMs: totalDurations.length ? Math.max(...totalDurations) : null,
      backendPerfAvailable: batches.some((batch) => Object.keys(batch.timing.backend).length > 0),
    },
    batches,
    tokens: tokenRequests,
  };
}
