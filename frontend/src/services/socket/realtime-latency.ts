import type { MarketBucketUpdateEvent, RealtimeLatencyMarks } from './market-events';

const WINDOW_LIMIT = 512;
const samples: Record<string, number>[] = [];
let lastEventAt: string | null = null;

function timestampMs(value: unknown) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function percentile(sorted: number[], ratio: number) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function summarize(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.at(-1) ?? null,
  };
}

function duration(start: unknown, end: number) {
  const startedAt = timestampMs(start);
  return startedAt != null && end >= startedAt ? end - startedAt : null;
}

export function recordMarketBucketApplied(
  event: MarketBucketUpdateEvent,
  appliedAt = Date.now(),
) {
  const marks: RealtimeLatencyMarks = {
    ...(event.latency || {}),
    clientAppliedAt: new Date(appliedAt).toISOString(),
  };
  const receivedAt = timestampMs(marks.clientReceivedAt);
  const sample = {
    receiptToAppliedMs: duration(marks.receiptsAvailableAt, appliedAt),
    captureToAppliedMs: duration(marks.captureCommittedAt, appliedAt),
    projectionToAppliedMs: duration(marks.projectionCommittedAt, appliedAt),
    publishedToReceivedMs: receivedAt == null
      ? null : duration(marks.publishedAt, receivedAt),
    receivedToAppliedMs: receivedAt == null || appliedAt < receivedAt
      ? null : appliedAt - receivedAt,
  };
  const valid = Object.fromEntries(
    Object.entries(sample).filter(([, value]) => Number.isFinite(value))
  ) as Record<string, number>;
  if (!Object.keys(valid).length) return false;
  samples.push(valid);
  if (samples.length > WINDOW_LIMIT) samples.splice(0, samples.length - WINDOW_LIMIT);
  lastEventAt = marks.clientAppliedAt || null;
  return true;
}

export function getMarketBucketLatencySnapshot(now = Date.now()) {
  const stages = [
    'receiptToAppliedMs', 'captureToAppliedMs', 'projectionToAppliedMs',
    'publishedToReceivedMs', 'receivedToAppliedMs',
  ];
  return {
    flow: 'market:bucket',
    sampleCount: samples.length,
    lastEventAt,
    lastEventAgeMs: lastEventAt == null ? null : Math.max(0, now - Date.parse(lastEventAt)),
    windowLimit: WINDOW_LIMIT,
    stages: Object.fromEntries(stages.map((stage) => [
      stage,
      summarize(samples.map((sample) => sample[stage]).filter(Number.isFinite)),
    ])),
  };
}

export function resetMarketBucketLatency() {
  samples.length = 0;
  lastEventAt = null;
}
