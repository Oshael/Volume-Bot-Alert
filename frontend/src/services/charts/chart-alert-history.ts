import type { ChartAlertEvent, ChartAlertEventsPayload, DashboardAlertEvent } from '../api/catalog';

export const EXPANDED_CHART_ALERT_EVENT = 'trendscope:expanded-chart-alert';
export const CHART_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;
const CHART_ALERT_RULE_KEYS = new Set([
  'monitored-vol',
  'monitored-mcap',
  'hvnc',
  'recent-surge-1h',
  'recent-surge-6h',
  'old-week-surge-1h',
  'old-week-surge-6h',
  'meteora-surge',
]);

type ChartAlertBucket = {
  events: Map<string, ChartAlertEvent>;
  serverClockOffsetMs: number;
  truncated: boolean;
};

const chartAlertBuckets = new Map<string, ChartAlertBucket>();

function toOptionalNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

export function isChartAlertRuleKey(value: unknown) {
  return CHART_ALERT_RULE_KEYS.has(normalizeText(value).toLowerCase());
}

export function normalizeChartAlertEvent(input: Partial<ChartAlertEvent> | DashboardAlertEvent): ChartAlertEvent | null {
  const id = Number(input.id);
  const ruleKey = normalizeText(input.ruleKey).toLowerCase();
  const address = normalizeText(input.address);
  const triggeredAtMs = Date.parse(normalizeText(input.triggeredAt));
  if (!Number.isInteger(id) || id <= 0 || !isChartAlertRuleKey(ruleKey) || !address || !Number.isFinite(triggeredAtMs)) {
    return null;
  }

  return {
    ...input,
    id,
    ruleKey,
    kind: normalizeText(input.kind) || ruleKey,
    address,
    triggeredAt: new Date(triggeredAtMs).toISOString(),
    mcap: toOptionalNumber(input.mcap),
    pct: toOptionalNumber(input.pct),
    label: normalizeText(input.label) || null,
  } as ChartAlertEvent;
}

function getBucket(address: string) {
  const normalizedAddress = normalizeText(address);
  let bucket = chartAlertBuckets.get(normalizedAddress);
  if (!bucket) {
    bucket = { events: new Map(), serverClockOffsetMs: 0, truncated: false };
    chartAlertBuckets.set(normalizedAddress, bucket);
  }
  return bucket;
}

function getEventKey(event: ChartAlertEvent) {
  return `${event.ruleKey}:${event.id}`;
}

function getServerNowMs(bucket: ChartAlertBucket, clientNowMs = Date.now()) {
  return clientNowMs + bucket.serverClockOffsetMs;
}

function pruneBucket(bucket: ChartAlertBucket, clientNowMs = Date.now()) {
  const cutoff = getServerNowMs(bucket, clientNowMs) - CHART_ALERT_WINDOW_MS;
  for (const [key, event] of bucket.events) {
    if (Date.parse(event.triggeredAt) < cutoff) {
      bucket.events.delete(key);
    }
  }
}

export function mergeChartAlertHistory(payload: ChartAlertEventsPayload, clientNowMs = Date.now()) {
  const address = normalizeText(payload.address);
  const bucket = getBucket(address);
  const generatedAtMs = Date.parse(normalizeText(payload.generatedAt));
  bucket.serverClockOffsetMs = Number.isFinite(generatedAtMs) ? generatedAtMs - clientNowMs : 0;
  bucket.truncated = Boolean(payload.truncated);
  for (const input of payload.events || []) {
    const event = normalizeChartAlertEvent(input);
    if (event && event.address === address) {
      bucket.events.set(getEventKey(event), event);
    }
  }
  pruneBucket(bucket, clientNowMs);
  return readChartAlertHistory(address, clientNowMs);
}

export function upsertRealtimeChartAlert(input: DashboardAlertEvent, clientNowMs = Date.now()) {
  const event = normalizeChartAlertEvent(input);
  if (!event) return null;
  const bucket = getBucket(event.address);
  bucket.events.set(getEventKey(event), event);
  pruneBucket(bucket, clientNowMs);
  return event;
}

export function readChartAlertHistory(address: string, clientNowMs = Date.now()) {
  const bucket = chartAlertBuckets.get(normalizeText(address));
  if (!bucket) return { events: [] as ChartAlertEvent[], truncated: false, nextExpiryAt: null as number | null };
  pruneBucket(bucket, clientNowMs);
  const events = [...bucket.events.values()].sort((left, right) => (
    Date.parse(left.triggeredAt) - Date.parse(right.triggeredAt) || left.id - right.id
  ));
  const nextExpiryAt = events.length > 0
    ? Date.parse(events[0].triggeredAt) + CHART_ALERT_WINDOW_MS - bucket.serverClockOffsetMs
    : null;
  return { events, truncated: bucket.truncated, nextExpiryAt };
}

export function publishRealtimeChartAlert(input: DashboardAlertEvent) {
  const event = upsertRealtimeChartAlert(input);
  if (event && typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent(EXPANDED_CHART_ALERT_EVENT, { detail: event }));
  }
  return event;
}

export function clearChartAlertHistory() {
  chartAlertBuckets.clear();
}
