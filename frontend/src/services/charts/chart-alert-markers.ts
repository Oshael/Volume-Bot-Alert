import type { ChartAlertEvent } from '../api/catalog';

export type ChartAlertCandlePoint = {
  time: number;
  high: number;
  close: number;
};

export type ChartAlertScaleAdapter = {
  logicalToCoordinate(logical: number): number | null;
  timeToCoordinate?(time: number): number | null;
  priceToCoordinate(price: number): number | null;
};

export type ChartAlertMarkerCode = 'V' | '$' | 'H' | 'S' | 'L';

export type ProjectedChartAlertMarker = {
  id: string;
  event: ChartAlertEvent;
  code: ChartAlertMarkerCode;
  tone: string;
  priority: number;
  x: number;
  y: number;
  mcapAvailable: boolean;
  title: string;
  summary: string;
  ariaLabel: string;
};

export type ChartAlertMarkerCluster = {
  id: string;
  markers: ProjectedChartAlertMarker[];
  x: number;
  y: number;
  code: ChartAlertMarkerCode;
  tone: string;
  overflow: number;
  title: string;
  ariaLabel: string;
};

type AlertVisualMeta = {
  code: ChartAlertMarkerCode;
  tone: string;
  priority: number;
  title: string;
};

const ALERT_VISUAL_META: Record<string, AlertVisualMeta> = {
  'monitored-vol': { code: 'V', tone: 'volume', priority: 10, title: 'Volume alert' },
  'monitored-mcap': { code: '$', tone: 'mcap', priority: 20, title: 'Market cap alert' },
  hvnc: { code: 'H', tone: 'hvnc', priority: 50, title: 'HVNC alert' },
  'recent-surge-1h': { code: 'S', tone: 'surge', priority: 40, title: 'Price surge alert' },
  'recent-surge-6h': { code: 'S', tone: 'surge', priority: 40, title: 'Price surge alert' },
  'old-week-surge-1h': { code: 'S', tone: 'surge', priority: 40, title: 'Price surge alert' },
  'old-week-surge-6h': { code: 'S', tone: 'surge', priority: 40, title: 'Price surge alert' },
  'surge-continuation-6h': { code: 'S', tone: 'surge', priority: 40, title: 'Surge continuation alert' },
  'meteora-surge': { code: 'L', tone: 'liquidity', priority: 30, title: 'Liquidity alert' },
};

const DEFAULT_HIT_WIDTH = 28;
const DEFAULT_HIT_HEIGHT = 28;
const FALLBACK_MARKER_OFFSET_PX = 14;

function toFiniteNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatCompactMoney(value: number | null | undefined) {
  const number = toFiniteNumber(value);
  if (number == null) return 'MCAP unavailable';
  const abs = Math.abs(number);
  if (abs >= 1_000_000_000) return `$${(number / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(number / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(number / 1_000).toFixed(1)}K`;
  return `$${number.toFixed(0)}`;
}

function formatPercent(value: number | null | undefined) {
  const number = toFiniteNumber(value);
  if (number == null) return null;
  const prefix = number > 0 ? '+' : '';
  return `${prefix}${number.toFixed(Math.abs(number) >= 10 ? 0 : 1)}%`;
}

function getAlertVisualMeta(event: ChartAlertEvent) {
  return ALERT_VISUAL_META[event.ruleKey] || null;
}

function getMarkerId(event: ChartAlertEvent) {
  return `${event.ruleKey}:${event.id}`;
}

function getEventTimestampSeconds(event: ChartAlertEvent) {
  const timestamp = Date.parse(event.triggeredAt);
  return Number.isFinite(timestamp) ? timestamp / 1000 : null;
}

type BucketProjection = {
  logical: number;
  candle: ChartAlertCandlePoint;
  eventSeconds: number;
  bucketStart: number;
  candleIndex: number;
  nextCandleIndex: number | null;
};

function getSortedFiniteCandles(candles: ChartAlertCandlePoint[]) {
  let sorted = true;
  let previousTime = -Infinity;
  const finiteCandles: ChartAlertCandlePoint[] = [];

  for (const candle of candles) {
    if (!Number.isFinite(candle.time)) {
      continue;
    }
    if (candle.time < previousTime) {
      sorted = false;
    }
    previousTime = candle.time;
    finiteCandles.push(candle);
  }

  return sorted
    ? finiteCandles
    : finiteCandles.sort((left, right) => left.time - right.time);
}

function findFirstCandleIndexAtOrAfter(candles: ChartAlertCandlePoint[], time: number) {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].time < time) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function findBucketProjection(candles: ChartAlertCandlePoint[], eventSeconds: number, granularityMinutes: number): BucketProjection | null {
  const granularitySeconds = Math.max(60, Math.round(Number(granularityMinutes) || 5) * 60);
  const bucketStart = Math.floor(eventSeconds / granularitySeconds) * granularitySeconds;
  const exactIndex = findFirstCandleIndexAtOrAfter(candles, bucketStart);
  if (candles[exactIndex]?.time === bucketStart) {
    const fraction = Math.max(0, Math.min(0.999, (eventSeconds - bucketStart) / granularitySeconds));
    return {
      logical: exactIndex + fraction,
      candle: candles[exactIndex],
      eventSeconds,
      bucketStart,
      candleIndex: exactIndex,
      nextCandleIndex: candles[exactIndex + 1] ? exactIndex + 1 : null,
    };
  }

  const nextIndex = findFirstCandleIndexAtOrAfter(candles, eventSeconds);
  const previousIndex = nextIndex > 0 ? nextIndex - 1 : -1;
  const previous = candles[previousIndex];
  const next = candles[nextIndex];
  if (!previous || !next || previous.time >= eventSeconds || next.time <= eventSeconds) {
    return null;
  }

  const fraction = (eventSeconds - previous.time) / (next.time - previous.time);
  return {
    logical: previousIndex + ((nextIndex - previousIndex) * fraction),
    candle: previous,
    eventSeconds,
    bucketStart,
    candleIndex: previousIndex,
    nextCandleIndex: nextIndex,
  };
}

function getCoordinateFromTime(timeToCoordinate: (time: number) => number | null, time: number) {
  const coordinate = timeToCoordinate(time);
  return coordinate == null || !Number.isFinite(coordinate) ? null : coordinate;
}

function interpolateTimeCoordinate(candles: ChartAlertCandlePoint[], projection: BucketProjection, scale: ChartAlertScaleAdapter) {
  if (!scale.timeToCoordinate) {
    return null;
  }

  const exact = getCoordinateFromTime(scale.timeToCoordinate, projection.eventSeconds);
  if (exact != null) {
    return exact;
  }

  const currentIndex = candles[projection.candleIndex]?.time === projection.bucketStart
    ? projection.candleIndex
    : -1;
  if (currentIndex >= 0) {
    const startX = getCoordinateFromTime(scale.timeToCoordinate, candles[currentIndex].time);
    const next = candles[currentIndex + 1];
    const nextX = next ? getCoordinateFromTime(scale.timeToCoordinate, next.time) : null;
    if (startX != null && nextX != null && next.time > candles[currentIndex].time) {
      const fraction = Math.max(0, Math.min(1, (projection.eventSeconds - candles[currentIndex].time) / (next.time - candles[currentIndex].time)));
      return startX + ((nextX - startX) * fraction);
    }
    if (startX != null) {
      return startX;
    }
  }

  const previous = candles[projection.candleIndex];
  const next = projection.nextCandleIndex == null ? null : candles[projection.nextCandleIndex];
  if (!previous || !next || previous.time >= projection.eventSeconds || next.time <= projection.eventSeconds) {
    return null;
  }
  const previousX = getCoordinateFromTime(scale.timeToCoordinate, previous.time);
  const nextX = getCoordinateFromTime(scale.timeToCoordinate, next.time);
  if (previousX == null || nextX == null) {
    return null;
  }
  const fraction = (projection.eventSeconds - previous.time) / (next.time - previous.time);
  return previousX + ((nextX - previousX) * fraction);
}

function getMarkerX(candles: ChartAlertCandlePoint[], projection: BucketProjection, scale: ChartAlertScaleAdapter) {
  const timeCoordinate = interpolateTimeCoordinate(candles, projection, scale);
  if (timeCoordinate != null) {
    return timeCoordinate;
  }
  const logicalCoordinate = scale.logicalToCoordinate(projection.logical);
  return logicalCoordinate == null || !Number.isFinite(logicalCoordinate) ? null : logicalCoordinate;
}

function getMarkerY(event: ChartAlertEvent, candle: ChartAlertCandlePoint, scale: ChartAlertScaleAdapter) {
  const mcap = toFiniteNumber(event.mcap);
  if (mcap != null && mcap > 0) {
    const y = scale.priceToCoordinate(mcap);
    return y == null || !Number.isFinite(y) ? null : { y, mcapAvailable: true };
  }

  const fallbackPrice = toFiniteNumber(candle.high) ?? toFiniteNumber(candle.close);
  if (fallbackPrice == null || fallbackPrice <= 0) {
    return null;
  }
  const y = scale.priceToCoordinate(fallbackPrice);
  return y == null || !Number.isFinite(y)
    ? null
    : { y: y - FALLBACK_MARKER_OFFSET_PX, mcapAvailable: false };
}

function buildMarkerSummary(event: ChartAlertEvent) {
  const percent = formatPercent(event.pct ?? event.priceChange1h ?? event.priceChange6h);
  return percent ? `${formatCompactMoney(event.mcap)} · ${percent}` : formatCompactMoney(event.mcap);
}

export function projectChartAlertMarkers(
  events: ChartAlertEvent[],
  candles: ChartAlertCandlePoint[],
  scale: ChartAlertScaleAdapter,
  granularityMinutes: number,
) {
  if (!events.length || !candles.length) {
    return [];
  }

  const sortedCandles = getSortedFiniteCandles(candles);
  const markers: ProjectedChartAlertMarker[] = [];

  for (const event of events) {
    const meta = getAlertVisualMeta(event);
    const eventSeconds = getEventTimestampSeconds(event);
    if (!meta || eventSeconds == null) {
      continue;
    }
    const projection = findBucketProjection(sortedCandles, eventSeconds, granularityMinutes);
    if (!projection) {
      continue;
    }
    const x = getMarkerX(sortedCandles, projection, scale);
    const markerY = getMarkerY(event, projection.candle, scale);
    if (x == null || !markerY) {
      continue;
    }

    const title = event.label || meta.title;
    const summary = buildMarkerSummary(event);
    markers.push({
      id: getMarkerId(event),
      event,
      code: meta.code,
      tone: meta.tone,
      priority: meta.priority,
      x,
      y: markerY.y,
      mcapAvailable: markerY.mcapAvailable,
      title,
      summary,
      ariaLabel: `${title} at ${new Date(event.triggeredAt).toLocaleString()} — ${summary}`,
    });
  }

  return markers.sort((left, right) => left.x - right.x || left.y - right.y || right.priority - left.priority);
}

function collides(left: ProjectedChartAlertMarker, right: ProjectedChartAlertMarker, hitWidth: number, hitHeight: number) {
  return Math.abs(left.x - right.x) < hitWidth && Math.abs(left.y - right.y) < hitHeight;
}

export function clusterChartAlertMarkers(
  markers: ProjectedChartAlertMarker[],
  options: { hitWidth?: number; hitHeight?: number } = {},
) {
  const hitWidth = options.hitWidth ?? DEFAULT_HIT_WIDTH;
  const hitHeight = options.hitHeight ?? DEFAULT_HIT_HEIGHT;
  const clusters: ProjectedChartAlertMarker[][] = [];

  for (const marker of markers) {
    const cluster = clusters.find((candidate) => candidate.some((existing) => collides(existing, marker, hitWidth, hitHeight)));
    if (cluster) {
      cluster.push(marker);
    } else {
      clusters.push([marker]);
    }
  }

  return clusters.map((cluster) => {
    const sorted = [...cluster].sort((left, right) => right.priority - left.priority || left.x - right.x || left.y - right.y);
    const representative = sorted[0];
    const titles = sorted.map((marker) => marker.title).join(', ');
    return {
      id: sorted.map((marker) => marker.id).join('|'),
      markers: sorted,
      x: representative.x,
      y: representative.y,
      code: representative.code,
      tone: representative.tone,
      overflow: Math.max(0, sorted.length - 1),
      title: sorted.length > 1 ? `${sorted.length} alerts` : representative.title,
      ariaLabel: sorted.length > 1 ? `${sorted.length} chart alerts: ${titles}` : representative.ariaLabel,
    } satisfies ChartAlertMarkerCluster;
  });
}
