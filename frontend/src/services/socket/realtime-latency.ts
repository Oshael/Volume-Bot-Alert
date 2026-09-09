import type {
  MarketBucketUpdateEvent,
  MarketTradeUpdateEvent,
  RealtimeLatencyMarks,
} from './market-events';

const WINDOW_LIMIT = 512;
export type RealtimeLatencyFlow = 'market:bucket' | 'market:trade' | 'alert:event';
type LatencyEvent = { latency?: RealtimeLatencyMarks };

const FLOW_STAGES: Record<RealtimeLatencyFlow, Record<string, keyof RealtimeLatencyMarks>> = {
  'market:bucket': {
    receiptToAppliedMs: 'receiptsAvailableAt',
    captureToAppliedMs: 'captureCommittedAt',
    projectionToAppliedMs: 'projectionCommittedAt',
  },
  'market:trade': {
    receiptToAppliedMs: 'receiptsAvailableAt',
    captureToAppliedMs: 'captureCommittedAt',
    projectionToAppliedMs: 'projectionCommittedAt',
  },
  'alert:event': {
    observedToAppliedMs: 'eventObservedAt',
    projectionToAppliedMs: 'projectionCommittedAt',
  },
};

const trackers = Object.fromEntries(Object.keys(FLOW_STAGES).map((flow) => [flow, {
  samples: [] as Record<string, number>[],
  lastEventAt: null as string | null,
}])) as Record<RealtimeLatencyFlow, {
  samples: Record<string, number>[];
  lastEventAt: string | null;
}>;

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

function recordApplied(flow: RealtimeLatencyFlow, event: LatencyEvent, appliedAt: number) {
  const marks: RealtimeLatencyMarks = {
    ...(event.latency || {}),
    clientAppliedAt: new Date(appliedAt).toISOString(),
  };
  const receivedAt = timestampMs(marks.clientReceivedAt);
  const stageSample = Object.fromEntries(Object.entries(FLOW_STAGES[flow]).map(
    ([stage, source]) => [stage, duration(marks[source], appliedAt)],
  ));
  const sample = {
    ...stageSample,
    publishedToReceivedMs: receivedAt == null
      ? null : duration(marks.publishedAt, receivedAt),
    receivedToAppliedMs: receivedAt == null || appliedAt < receivedAt
      ? null : appliedAt - receivedAt,
  };
  const valid = Object.fromEntries(
    Object.entries(sample).filter(([, value]) => Number.isFinite(value))
  ) as Record<string, number>;
  if (!Object.keys(valid).length) return false;
  const tracker = trackers[flow];
  tracker.samples.push(valid);
  if (tracker.samples.length > WINDOW_LIMIT) {
    tracker.samples.splice(0, tracker.samples.length - WINDOW_LIMIT);
  }
  tracker.lastEventAt = marks.clientAppliedAt || null;
  return true;
}

export function recordMarketBucketApplied(
  event: MarketBucketUpdateEvent,
  appliedAt = Date.now(),
) {
  return recordApplied('market:bucket', event, appliedAt);
}

export function recordMarketTradeApplied(
  event: MarketTradeUpdateEvent,
  appliedAt = Date.now(),
) {
  return recordApplied('market:trade', event, appliedAt);
}

export function recordAlertApplied(event: LatencyEvent, appliedAt = Date.now()) {
  return recordApplied('alert:event', event, appliedAt);
}

export function getRealtimeLatencySnapshot(
  flow: RealtimeLatencyFlow = 'market:bucket',
  now = Date.now(),
) {
  const tracker = trackers[flow];
  const stages = [...Object.keys(FLOW_STAGES[flow]),
    'publishedToReceivedMs', 'receivedToAppliedMs'];
  return {
    flow,
    sampleCount: tracker.samples.length,
    lastEventAt: tracker.lastEventAt,
    lastEventAgeMs: tracker.lastEventAt == null
      ? null : Math.max(0, now - Date.parse(tracker.lastEventAt)),
    windowLimit: WINDOW_LIMIT,
    stages: Object.fromEntries(stages.map((stage) => [
      stage,
      summarize(tracker.samples.map((sample) => sample[stage]).filter(Number.isFinite)),
    ])),
  };
}

export function getMarketBucketLatencySnapshot(now = Date.now()) {
  return getRealtimeLatencySnapshot('market:bucket', now);
}

export function resetRealtimeLatency(flow: RealtimeLatencyFlow) {
  trackers[flow].samples.length = 0;
  trackers[flow].lastEventAt = null;
}

export function resetMarketBucketLatency() {
  resetRealtimeLatency('market:bucket');
}
