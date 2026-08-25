import { apiFetch } from '../api/base';
import type { TokenChain } from '../../utils/token-chain';

export type ChartCalloutEvent = {
  id: string;
  platform: 'pump' | 'fomo';
  occurredAt: string;
  thesis: string | null;
  profile: {
    username: string | null;
    displayName: string | null;
    profilePictureUrl: string | null;
  };
  source: { links: Array<{ link: string; text?: string | null; provider?: string | null }> };
};

type CalloutPage = {
  from: string;
  to: string;
  events: ChartCalloutEvent[];
  hasMore: boolean;
  nextCursor: string | null;
};

export type ChartCalloutCandle = { time: number; high: number };
export type ChartCalloutGroup = {
  id: string;
  bucketStart: number;
  x: number;
  y: number;
  events: ChartCalloutEvent[];
};

type CalloutScale = {
  timeToCoordinate(time: number): number | null;
  priceToCoordinate(price: number): number | null;
};

const CACHE_MS = 30_000;
const MAX_PAGES = 50;
const cache = new Map<string, { expiresAt: number; request: Promise<ChartCalloutEvent[]> }>();

export function groupChartCallouts(
  events: ChartCalloutEvent[],
  candles: ChartCalloutCandle[],
  scale: CalloutScale,
  granularityMinutes: number,
) {
  const seconds = Math.max(60, Math.round(granularityMinutes || 5) * 60);
  const candleByTime = new Map(candles.map((candle) => [candle.time, candle]));
  const grouped = new Map<number, ChartCalloutEvent[]>();
  for (const event of events) {
    const timestamp = Date.parse(event.occurredAt) / 1000;
    const bucket = Math.floor(timestamp / seconds) * seconds;
    if (!Number.isFinite(timestamp) || !candleByTime.has(bucket)) continue;
    grouped.set(bucket, [...(grouped.get(bucket) || []), event]);
  }
  const result: ChartCalloutGroup[] = [];
  for (const [bucketStart, bucketEvents] of grouped) {
    const candle = candleByTime.get(bucketStart);
    const x = scale.timeToCoordinate(bucketStart);
    const priceY = candle ? scale.priceToCoordinate(candle.high) : null;
    if (x == null || priceY == null || !Number.isFinite(x) || !Number.isFinite(priceY)) continue;
    result.push({
      id: `callouts:${bucketStart}`,
      bucketStart,
      x,
      y: Math.max(18, priceY - 24),
      events: bucketEvents.sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt)),
    });
  }
  return result.sort((left, right) => left.bucketStart - right.bucketStart);
}

async function loadAllPages(chain: TokenChain, address: string, token?: string | null) {
  const to = new Date();
  const from = new Date(to.getTime() - (72 * 60 * 60 * 1000));
  const events: ChartCalloutEvent[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      chain, token: address, from: from.toISOString(), to: to.toISOString(), limit: '200',
    });
    if (cursor) query.set('cursor', cursor);
    const payload = await apiFetch<CalloutPage>(`/api/callouts/events?${query}`, { token });
    events.push(...(Array.isArray(payload.events) ? payload.events : []));
    if (!payload.hasMore || !payload.nextCursor) return events;
    cursor = payload.nextCursor;
  }
  console.warn('[ExpandedChart] Callout page safety limit reached');
  return events;
}

export function fetchChartCallouts(chain: TokenChain, address: string, token?: string | null) {
  const key = `${chain}:${address}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.request;
  const request = loadAllPages(chain, address, token).catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, { expiresAt: Date.now() + CACHE_MS, request });
  return request;
}
