import type { ChartAlertEvent, ChartAlertEventsPayload, DashboardAlertEvent } from '../api/catalog';

export const EXPANDED_CHART_ALERT_EVENT = 'trendscope:expanded-chart-alert';
export const CHART_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;
const CHART_ALERT_RULE_KEYS = new Set([
  'monitored-vol',
  'monitored-mcap',
  'monitored-fdv',
  'hvnc',
  'recent-surge-1h',
  'recent-surge-6h',
  'old-week-surge-1h',
  'old-week-surge-6h',
  'surge-continuation-6h',
  'meteora-surge',
  'custom-alert',
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
  const chain = normalizeText(input.chain).toLowerCase() || 'solana';
  const ruleKey = normalizeText(input.ruleKey).toLowerCase();
  const address = normalizeText(input.address);
  const triggeredAtMs = Date.parse(normalizeText(input.triggeredAt));
  if (!['solana', 'robinhood'].includes(chain) || !Number.isInteger(id) || id <= 0 || !isChartAlertRuleKey(ruleKey) || !address || !Number.isFinite(triggeredAtMs)) {
    return null;
  }

  return {
    ...input,
    id,
    chain,
    ruleKey,
    kind: normalizeText(input.kind) || ruleKey,
    address,
    triggeredAt: new Date(triggeredAtMs).toISOString(),
    mcap: toOptionalNumber(input.mcap),
    fdv: toOptionalNumber(input.fdv),
    valuationType: input.valuationType === 'fdv' || chain === 'robinhood' ? 'fdv' : 'market-cap',
    prevMcap: toOptionalNumber(input.prevMcap),
    prevFdv: toOptionalNumber(input.prevFdv),
    volume1h: toOptionalNumber(input.volume1h),
    volume6h: toOptionalNumber(input.volume6h),
    volume24h: toOptionalNumber(input.volume24h),
    pct: toOptionalNumber(input.pct),
    label: normalizeText(input.label) || null,
    customRuleId: toOptionalNumber(input.customRuleId),
    customCurrentValue: toOptionalNumber(input.customCurrentValue),
    customPreviousValue: toOptionalNumber(input.customPreviousValue),
  } as ChartAlertEvent;
}

function getBucketKey(chain: string, address: string) {
  return `${normalizeText(chain).toLowerCase() || 'solana'}:${normalizeText(address)}`;
}

function getBucket(chain: string, address: string) {
  const key = getBucketKey(chain, address);
  let bucket = chartAlertBuckets.get(key);
  if (!bucket) {
    bucket = { events: new Map(), serverClockOffsetMs: 0, truncated: false };
    chartAlertBuckets.set(key, bucket);
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
  const chain = normalizeText(payload.chain).toLowerCase() || 'solana';
  const bucket = getBucket(chain, address);
  const generatedAtMs = Date.parse(normalizeText(payload.generatedAt));
  bucket.serverClockOffsetMs = Number.isFinite(generatedAtMs) ? generatedAtMs - clientNowMs : 0;
  bucket.truncated = Boolean(payload.truncated);
  for (const input of payload.events || []) {
    const event = normalizeChartAlertEvent(input);
    if (event && event.chain === chain && event.address === address) {
      bucket.events.set(getEventKey(event), event);
    }
  }
  pruneBucket(bucket, clientNowMs);
  return readChartAlertHistory(chain, address, clientNowMs);
}

export function upsertRealtimeChartAlert(input: DashboardAlertEvent, clientNowMs = Date.now()) {
  const event = normalizeChartAlertEvent(input);
  if (!event) return null;
  const bucket = getBucket(event.chain, event.address);
  bucket.events.set(getEventKey(event), event);
  pruneBucket(bucket, clientNowMs);
  return event;
}

export function readChartAlertHistory(chain: string, address: string, clientNowMs = Date.now()) {
  const bucket = chartAlertBuckets.get(getBucketKey(chain, address));
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
