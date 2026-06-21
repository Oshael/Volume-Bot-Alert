import { apiFetch } from './base';
import type { MonitoredSortCriterion } from '../../state/app-state';

export interface ReportMigratedTokenPayload {
  address: string;
  symbol?: string | null;
  name?: string | null;
  tokenCreatedAt?: number | null;
  mcap?: number | null;
  imageUrl?: string | null;
  twitterUrl?: string | null;
  pairUrl?: string | null;
}

export function reportMigratedToken(payload: ReportMigratedTokenPayload, token?: string | null) {
  return apiFetch<{ message: string }>('/api/catalog/migrated', {
    method: 'POST',
    body: JSON.stringify({
      address: payload.address,
      source: 'pumpfun-migrated',
      chain: 'solana',
      symbol: payload.symbol ?? null,
      name: payload.name ?? null,
      tokenCreatedAt: payload.tokenCreatedAt ?? null,
      mcap: payload.mcap ?? null,
      imageUrl: payload.imageUrl ?? null,
      twitterUrl: payload.twitterUrl ?? null,
      pairUrl: payload.pairUrl ?? null,
      isActiveMonitorCandidate: true,
    }),
    token,
  });
}

export function trackManualToken(address: string, token?: string | null) {
  return apiFetch<{ message: string; tracked: { address: string }; bootstrapState?: 'scheduled' | 'evaluated' | null }>('/api/catalog/manual-track', {
    method: 'POST',
    body: JSON.stringify({ address }),
    token,
  });
}

export function adminBlockToken(address: string, label?: string | null, token?: string | null) {
  return apiFetch<{ message: string; blocked: { address: string; label?: string | null } }>('/api/catalog/admin-blocklist', {
    method: 'POST',
    body: JSON.stringify({ address, label: label ?? null }),
    token,
  });
}

export function adminUnblockToken(address: string, token?: string | null) {
  return apiFetch<{ message: string; address: string }>(`/api/catalog/admin-blocklist/${encodeURIComponent(address)}`, {
    method: 'DELETE',
    token,
  });
}

export interface EligibleCatalogToken {
  address: string;
  symbol?: string | null;
  name?: string | null;
  mcap?: number | null;
  lastSeenAt?: string | null;
  lastEvaluatedAt?: string | null;
}

export interface DashboardMonitoredToken {
  address: string;
  symbol?: string | null;
  name?: string | null;
  pairAddress?: string | null;
  pairUrl?: string | null;
  imageUrl?: string | null;
  twitterUrl?: string | null;
  communityUrl?: string | null;
  eligibleForMonitoring?: boolean;
  monitorPriority?: string | null;
  mcap?: number | null;
  priceUsd?: number | null;
  volume5m?: number | null;
  volume1h?: number | null;
  volume6h?: number | null;
  volume24h?: number | null;
  priceChange1h?: number | null;
  priceChange6h?: number | null;
  priceChange24h?: number | null;
  tokenCreatedAt?: number | null;
  catalogFirstSeenAt?: number | null;
  prevMcap?: number | null;
  mcapDelta?: number | null;
  prevVolume5mCanonical?: number | null;
  lastSeenAt?: string | null;
  lastEvaluatedAt?: string | null;
  meteora?: MeteoraBatchItem | null;
  tickerPeers?: {
    sourceSymbol?: string | null;
    normalizedSymbol?: string | null;
    count?: number;
    exactCount?: number | null;
    subtickerCount?: number | null;
    hasSubtickerMatch?: boolean;
    sourcePeerRole?: 'og' | 'mcap_leader' | 'peer_warning' | null;
    oldestExactAddress?: string | null;
    highestMcapExactAddress?: string | null;
    items?: Array<{
      address: string;
      symbol?: string | null;
      name?: string | null;
      imageUrl?: string | null;
      mcap?: number | null;
      tokenCreatedAt?: number | null;
      ageMsAtAlert?: number | null;
      matchType?: 'exact' | 'subticker' | null;
    }>;
  } | null;
}

export interface DashboardMonitoredPayload {
  generatedAt?: string | null;
  tokens: DashboardMonitoredToken[];
  total?: number;
  page?: number;
  perPage?: number;
  hasMore?: boolean;
}

export interface DashboardHistoryBucketRequest {
  page?: number;
  perPage?: number;
  searchQuery?: string;
  starredOnly?: boolean;
  sorts?: Array<{
    mode: 'vol' | 'mcap' | 'pchange' | 'age';
    window: '1h' | '6h' | '24h' | 'highest' | 'lowest' | 'newest' | 'oldest';
  }>;
  dismissedAddresses?: string[];
  mcapMin?: number;
  mcapMax?: number;
  ageMinMinutes?: number;
  ageMaxMinutes?: number;
}

export interface DashboardHistoryBucketSlicePayload {
  total: number;
  page: number;
  perPage: number;
  count: number;
  tokens: DashboardMonitoredToken[];
}

export interface DashboardHistoryBootstrapPayload {
  generatedAt?: string | null;
  recent: DashboardHistoryBucketSlicePayload;
  oldWeek: DashboardHistoryBucketSlicePayload;
}

export interface DashboardTopPerformerToken extends DashboardMonitoredToken {
  performanceRank?: number | null;
  performanceScore?: number | null;
}

export interface DashboardTopPerformersPayload {
  generatedAt?: string | null;
  source?: string | null;
  ranking?: string | null;
  minMcap?: number | null;
  minVol24h?: number | null;
  count: number;
  cached?: boolean;
  tokens: DashboardTopPerformerToken[];
}

function normalizeDashboardHistoryBucketSlice(
  slice: Partial<DashboardHistoryBucketSlicePayload> | null | undefined,
): DashboardHistoryBucketSlicePayload {
  return {
    total: Number(slice?.total) || 0,
    page: Number(slice?.page) || 0,
    perPage: Number(slice?.perPage) || 30,
    count: Number(slice?.count) || 0,
    tokens: slice?.tokens || [],
  };
}

export interface DashboardAlertEvent {
  id: number;
  kind?: string | null;
  ruleKey?: string | null;
  address: string;
  symbol?: string | null;
  name?: string | null;
  pairAddress?: string | null;
  pairUrl?: string | null;
  imageUrl?: string | null;
  twitterUrl?: string | null;
  communityUrl?: string | null;
  tokenCreatedAt?: number | null;
  mcap?: number | null;
  priceChange1h?: number | null;
  priceChange6h?: number | null;
  volume1m?: number | null;
  volume1h?: number | null;
  volume6h?: number | null;
  volume24h?: number | null;
  volume5m?: number | null;
  prevVolume1m?: number | null;
  prevVolume5m?: number | null;
  prevMcap?: number | null;
  pct?: number | null;
  label?: string | null;
  isHvnc?: boolean;
  isOldSurge?: boolean;
  surgeWindow?: '1H' | '6H' | null;
  ageBucket?: 'recent' | 'old-week' | null;
  meteoraCurrentTvl?: number | null;
  meteoraBaselineTvl24h?: number | null;
  baselineTs?: string | null;
  baselineMcap?: number | null;
  windowLowMcap?: number | null;
  currentTs?: string | null;
  currentCloseMcap?: number | null;
  dumpPct?: number | null;
  thresholdPct?: number | null;
  signalType?: number | null;
  claimSequence?: number | null;
  claimId?: string | null;
  claimFeeAmount?: number | null;
  claimFeeCurrency?: string | null;
  claimFeeUsd?: number | null;
  quoteAddress?: string | null;
  totalFeeUsd?: number | null;
  claimedAt?: string | null;
  triggeredAt?: string | null;
  tickerPeers?: {
    sourceSymbol?: string | null;
    normalizedSymbol?: string | null;
    count?: number;
    exactCount?: number | null;
    subtickerCount?: number | null;
    hasSubtickerMatch?: boolean;
    sourcePeerRole?: 'og' | 'mcap_leader' | 'peer_warning' | null;
    oldestExactAddress?: string | null;
    highestMcapExactAddress?: string | null;
    items?: Array<{
      address: string;
      symbol?: string | null;
      name?: string | null;
      imageUrl?: string | null;
      mcap?: number | null;
      tokenCreatedAt?: number | null;
      ageMsAtAlert?: number | null;
      matchType?: 'exact' | 'subticker' | null;
    }>;
  } | null;
}

export interface DashboardAlertEventsPayload {
  generatedAt?: string | null;
  kind?: string | null;
  ruleKey?: string | null;
  mode?: string | null;
  cursor?: {
    ruleKey?: string | null;
    lastSeenEventId?: number | null;
    lastAckedEventId?: number | null;
    updatedAt?: string | null;
  } | null;
  count: number;
  events: DashboardAlertEvent[];
}

export interface DashboardAlertFeedsPayload {
  generatedAt?: string | null;
  mode?: string | null;
  count: number;
  feeds: DashboardAlertEventsPayload[];
}

export interface TokenSparklineItem {
  address: string;
  pairAddress?: string | null;
  bucketCount?: number;
  coverageRatio?: number | null;
  effectiveHours?: number | null;
  granularityMinutes?: number | null;
  firstBucketAt?: string | null;
  latestBucketAt?: string | null;
  series: number[];
}

export interface TokenSparklinesPayload {
  generatedAt?: string | null;
  hours?: number;
  points?: number;
  granularityMinutes?: number | null;
  count: number;
  items: TokenSparklineItem[];
}

export interface ExpandedTokenSparklinePayload {
  generatedAt?: string | null;
  points?: number;
  count: number;
  item: TokenSparklineItem | null;
}

export interface BidZoneCandidate {
  address: string;
  symbol?: string | null;
  name?: string | null;
  pairAddress?: string | null;
  pairUrl?: string | null;
  imageUrl?: string | null;
  twitterUrl?: string | null;
  communityUrl?: string | null;
  monitorPriority?: string | null;
  mcap?: number | null;
  catalogMcap?: number | null;
  windowMcap?: number | null;
  volume1h?: number | null;
  volume6h?: number | null;
  volume24h?: number | null;
  supportLevelMcap?: number | null;
  resistanceLevelMcap?: number | null;
  robustRangePct?: number | null;
  recentRangePct?: number | null;
  closeDriftPct?: number | null;
  supportDistancePct?: number | null;
  resistanceDistancePct?: number | null;
  supportTouchClusters?: number;
  coverageRatio?: number | null;
  bucketCount?: number;
  sampleCount?: number;
  expectedBucketCount?: number;
  ageHours?: number | null;
  requestedHours?: number;
  minimumWindowHours?: number;
  windowHoursUsed?: number;
  score?: number | null;
}

export interface BidZonePayload {
  generatedAt?: string | null;
  runId?: number | null;
  requestedHours?: number;
  minMcap?: number;
  minVol1h?: number;
  minVol24h?: number;
  candidateCount?: number;
  resultCount?: number;
  refreshAvailableAt?: string | null;
  refreshed?: boolean;
  retryAfterSeconds?: number;
  count: number;
  candidates: BidZoneCandidate[];
}

export interface MeteoraBatchItem {
  address: string;
  tvl?: number | null;
  poolAddress?: string | null;
  poolCount?: number;
  lastCheckedAt?: string | null;
  lastSnapshotAt?: string | null;
  change1h?: number | null;
  change6h?: number | null;
  change24h?: number | null;
  noPool?: boolean;
}

const FRONTEND_MONITORED_MIN_MCAP = 30_000;

export function fetchEligibleCatalog(token?: string | null) {
  return apiFetch<{
    tokens: Array<{
      address: string;
      symbol?: string | null;
      name?: string | null;
      mcap?: number | null;
      lastSeenAt?: string | null;
      lastEvaluatedAt?: string | null;
    }>;
  }>(`/api/catalog/eligible?minMcap=${FRONTEND_MONITORED_MIN_MCAP}`, { token })
    .then((response) => response.tokens.map((item) => ({
      address: item.address,
      symbol: item.symbol ?? null,
      name: item.name ?? null,
      mcap: item.mcap ?? null,
      lastSeenAt: item.lastSeenAt ?? null,
      lastEvaluatedAt: item.lastEvaluatedAt ?? null,
    })));
}

export function fetchDashboardMonitored(
  token?: string | null,
  options?: { page?: number; perPage?: number; sorts?: MonitoredSortCriterion[] },
) {
  const query = new URLSearchParams();
  if (options?.page != null) {
    query.set('page', String(Math.max(0, Math.trunc(options.page))));
  }
  if (options?.perPage != null) {
    query.set('perPage', String(Math.max(1, Math.trunc(options.perPage))));
  }
  if (Array.isArray(options?.sorts) && options.sorts.length > 0) {
    query.set('sorts', JSON.stringify(options.sorts));
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  return apiFetch<DashboardMonitoredPayload>(`/api/dashboard/monitored${suffix}`, { token })
    .then((response) => ({
      generatedAt: response.generatedAt ?? null,
      tokens: response.tokens || [],
      total: Number(response.total) || 0,
      page: Number(response.page) || 0,
      perPage: Number(response.perPage) || 0,
      hasMore: Boolean(response.hasMore),
    }));
}

export function fetchMonitoredMetadataBatch(
  addresses: string[],
  token?: string | null,
  options?: { includeMeteora?: boolean },
) {
  return apiFetch<{
    generatedAt?: string | null;
    count: number;
    tokens: DashboardMonitoredToken[];
  }>('/api/catalog/monitored-metadata-batch', {
    method: 'POST',
    body: JSON.stringify({
      addresses,
      includeMeteora: options?.includeMeteora ?? true,
    }),
    token,
  }).then((response) => response.tokens || []);
}

export function fetchDashboardHistoryBootstrap(
  payload: {
    starredTokens?: string[];
    recent?: DashboardHistoryBucketRequest;
    oldWeek?: DashboardHistoryBucketRequest;
  },
  token?: string | null,
) {
  return apiFetch<DashboardHistoryBootstrapPayload>('/api/dashboard/history-bootstrap', {
    method: 'POST',
    body: JSON.stringify({
      starredTokens: payload.starredTokens ?? [],
      recent: payload.recent ?? {},
      oldWeek: payload.oldWeek ?? {},
    }),
    token,
  }).then((response) => ({
    generatedAt: response.generatedAt ?? null,
    recent: normalizeDashboardHistoryBucketSlice(response.recent),
    oldWeek: normalizeDashboardHistoryBucketSlice(response.oldWeek),
  }));
}

export function fetchDashboardTopPerformers(
  token?: string | null,
  options?: { limit?: number; minMcap?: number; minVol24h?: number },
) {
  const query = new URLSearchParams();
  if (options?.limit != null) {
    query.set('limit', String(Math.max(1, Math.trunc(options.limit))));
  }
  if (options?.minMcap != null) {
    query.set('minMcap', String(Math.max(0, Number(options.minMcap) || 0)));
  }
  if (options?.minVol24h != null) {
    query.set('minVol24h', String(Math.max(0, Number(options.minVol24h) || 0)));
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  return apiFetch<DashboardTopPerformersPayload>(`/api/dashboard/top-performers${suffix}`, { token })
    .then((response) => ({
      generatedAt: response.generatedAt ?? null,
      source: response.source ?? null,
      ranking: response.ranking ?? null,
      minMcap: response.minMcap ?? null,
      minVol24h: response.minVol24h ?? null,
      count: Number(response.count) || 0,
      cached: Boolean(response.cached),
      tokens: Array.isArray(response.tokens) ? response.tokens.map((item) => ({
        ...item,
        performanceRank: item.performanceRank == null ? null : Number(item.performanceRank),
        performanceScore: item.performanceScore == null ? null : Number(item.performanceScore),
      })) : [],
    }));
}

export function fetchTokenSparklines(
  addresses: string[],
  options?: { hours?: number; points?: number; granularityMinutes?: number; allowOneMinuteFallback?: boolean },
  token?: string | null,
) {
  return apiFetch<TokenSparklinesPayload>('/api/catalog/sparklines', {
    method: 'POST',
    body: JSON.stringify({
      addresses,
      hours: options?.hours ?? (14 * 24),
      points: options?.points ?? 336,
      granularityMinutes: options?.granularityMinutes ?? 30,
      allowOneMinuteFallback: options?.allowOneMinuteFallback ?? false,
    }),
    token,
  }).then((response) => ({
    generatedAt: response.generatedAt ?? null,
    hours: Number(response.hours) || (14 * 24),
    points: Number(response.points) || 336,
    granularityMinutes: Number(response.granularityMinutes) || 30,
    count: Number(response.count) || 0,
    items: Array.isArray(response.items) ? response.items.map((item) => ({
      address: item.address,
      pairAddress: item.pairAddress ?? null,
      bucketCount: Number(item.bucketCount) || 0,
      coverageRatio: item.coverageRatio ?? null,
      effectiveHours: item.effectiveHours ?? null,
      granularityMinutes: Number(item.granularityMinutes) || Number(response.granularityMinutes) || 30,
      firstBucketAt: item.firstBucketAt ?? null,
      latestBucketAt: item.latestBucketAt ?? null,
      series: Array.isArray(item.series)
        ? item.series.map((value) => Number(value)).filter((value) => Number.isFinite(value))
        : [],
    })) : [],
  }));
}

export function fetchExpandedTokenSparkline(
  address: string,
  options?: { points?: number },
  token?: string | null,
) {
  return apiFetch<ExpandedTokenSparklinePayload>('/api/catalog/sparklines/expanded', {
    method: 'POST',
    body: JSON.stringify({
      address,
      points: options?.points ?? 720,
    }),
    token,
  }).then((response) => ({
    generatedAt: response.generatedAt ?? null,
    points: Number(response.points) || 720,
    count: Number(response.count) || 0,
    item: response.item ? {
      address: response.item.address,
      pairAddress: response.item.pairAddress ?? null,
      bucketCount: Number(response.item.bucketCount) || 0,
      coverageRatio: response.item.coverageRatio ?? null,
      effectiveHours: response.item.effectiveHours ?? null,
      granularityMinutes: Number(response.item.granularityMinutes) || 30,
      firstBucketAt: response.item.firstBucketAt ?? null,
      latestBucketAt: response.item.latestBucketAt ?? null,
      series: Array.isArray(response.item.series)
        ? response.item.series.map((value) => Number(value)).filter((value) => Number.isFinite(value))
        : [],
    } : null,
  }));
}

export function fetchMeteoraBatch(addresses: string[], token?: string | null) {
  return apiFetch<{ count?: number; items?: MeteoraBatchItem[] }>('/api/catalog/meteora/batch', {
    method: 'POST',
    body: JSON.stringify({ addresses }),
    token,
  }).then((response) => response.items || []);
}

export function fetchDashboardAlertEvents(token?: string | null, options?: { limit?: number; ruleKey?: string; mode?: string; afterId?: number }) {
  const params = new URLSearchParams();
  if (options?.limit) {
    params.set('limit', String(options.limit));
  }
  if (options?.ruleKey) {
    params.set('ruleKey', String(options.ruleKey));
  }
  if (options?.mode) {
    params.set('mode', String(options.mode));
  }
  if (options?.afterId) {
    params.set('afterId', String(options.afterId));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return apiFetch<DashboardAlertEventsPayload>(`/api/dashboard/alert-events${suffix}`, { token })
    .then((response) => ({
      generatedAt: response.generatedAt ?? null,
      kind: response.kind ?? null,
      ruleKey: response.ruleKey ?? null,
      mode: response.mode ?? null,
      cursor: response.cursor ?? null,
      count: Number(response.count) || 0,
      events: response.events || [],
    }));
}

export function fetchDashboardAlertFeeds(token?: string | null, options?: { limit?: number; mode?: string; ruleKeys?: string[] }) {
  const params = new URLSearchParams();
  if (options?.limit) {
    params.set('limit', String(options.limit));
  }
  if (options?.mode) {
    params.set('mode', String(options.mode));
  }
  if (Array.isArray(options?.ruleKeys) && options.ruleKeys.length > 0) {
    params.set('ruleKeys', options.ruleKeys.join(','));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return apiFetch<DashboardAlertFeedsPayload>(`/api/dashboard/alert-feeds${suffix}`, { token })
    .then((response) => ({
      generatedAt: response.generatedAt ?? null,
      mode: response.mode ?? null,
      count: Number(response.count) || 0,
      feeds: Array.isArray(response.feeds)
        ? response.feeds.map((feed) => ({
            generatedAt: feed.generatedAt ?? null,
            kind: feed.kind ?? null,
            ruleKey: feed.ruleKey ?? null,
            mode: feed.mode ?? null,
            cursor: feed.cursor ?? null,
            count: Number(feed.count) || 0,
            events: feed.events || [],
          }))
        : [],
    }));
}

export function updateDashboardAlertCursor(
  payload: { ruleKey?: string | null; lastSeenEventId?: number | null; lastAckedEventId?: number | null },
  token?: string | null
) {
  return apiFetch<{
    cursor?: {
      ruleKey?: string | null;
      lastSeenEventId?: number | null;
      lastAckedEventId?: number | null;
      updatedAt?: string | null;
    } | null;
  }>('/api/dashboard/alert-events/cursor', {
    method: 'POST',
    body: JSON.stringify({
      ruleKey: payload.ruleKey ?? null,
      lastSeenEventId: payload.lastSeenEventId ?? null,
      lastAckedEventId: payload.lastAckedEventId ?? null,
    }),
    token,
  });
}

export function fetchBidZoneCandidates(token?: string | null, options?: { limit?: number }) {
  const params = new URLSearchParams();
  if (options?.limit) {
    params.set('limit', String(options.limit));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return apiFetch<BidZonePayload>(`/api/catalog/bid-zone${suffix}`, { token })
    .then((response) => ({
      generatedAt: response.generatedAt ?? null,
      runId: response.runId ?? null,
      requestedHours: response.requestedHours,
      minMcap: response.minMcap,
      minVol1h: response.minVol1h,
      minVol24h: response.minVol24h,
      candidateCount: response.candidateCount,
      resultCount: response.resultCount,
      refreshAvailableAt: response.refreshAvailableAt ?? null,
      refreshed: response.refreshed,
      retryAfterSeconds: response.retryAfterSeconds,
      count: Number(response.count) || 0,
      candidates: response.candidates || [],
    }));
}

export function refreshBidZoneSnapshot(token?: string | null, options?: { limit?: number }) {
  const params = new URLSearchParams();
  if (options?.limit) {
    params.set('limit', String(options.limit));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return apiFetch<BidZonePayload>(`/api/catalog/bid-zone/refresh${suffix}`, {
    method: 'POST',
    token,
  }).then((response) => ({
    generatedAt: response.generatedAt ?? null,
    runId: response.runId ?? null,
    requestedHours: response.requestedHours,
    minMcap: response.minMcap,
    minVol1h: response.minVol1h,
    minVol24h: response.minVol24h,
    candidateCount: response.candidateCount,
    resultCount: response.resultCount,
    refreshAvailableAt: response.refreshAvailableAt ?? null,
    refreshed: response.refreshed,
    retryAfterSeconds: response.retryAfterSeconds,
    count: Number(response.count) || 0,
    candidates: response.candidates || [],
  }));
}

export function fetchPumpfunTokenMeta(mint: string, token?: string | null, metadataUri?: string | null) {
  const params = new URLSearchParams();
  if (metadataUri) {
    params.set('uri', metadataUri);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return apiFetch<{
    mint: string;
    symbol?: string | null;
    name?: string | null;
    imageUrl?: string | null;
  }>(`/api/catalog/pumpfun/${encodeURIComponent(mint)}/meta${suffix}`, { token });
}
