import { apiFetch } from './base';

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
  return apiFetch<{ message: string; tracked: { address: string } }>('/api/catalog/manual-track', {
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
  prevMcap?: number | null;
  mcapDelta?: number | null;
  prevVolume5mCanonical?: number | null;
  lastSeenAt?: string | null;
  lastEvaluatedAt?: string | null;
  meteora?: MeteoraBatchItem | null;
}

export interface DashboardMonitoredPayload {
  generatedAt?: string | null;
  tokens: DashboardMonitoredToken[];
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
  tokenCreatedAt?: number | null;
  mcap?: number | null;
  volume1h?: number | null;
  volume6h?: number | null;
  volume24h?: number | null;
  baselineTs?: string | null;
  baselineMcap?: number | null;
  windowLowMcap?: number | null;
  currentTs?: string | null;
  currentCloseMcap?: number | null;
  dumpPct?: number | null;
  thresholdPct?: number | null;
  triggeredAt?: string | null;
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

export interface LateralizedCandidate {
  address: string;
  symbol?: string | null;
  name?: string | null;
  monitorPriority?: string | null;
  mcap?: number | null;
  catalogMcap?: number | null;
  windowMcap?: number | null;
  volume1h?: number | null;
  volume6h?: number | null;
  volume24h?: number | null;
  rangePct?: number | null;
  rangeLimitPct?: number | null;
  driftPct?: number | null;
  driftLimitPct?: number | null;
  coverageRatio?: number | null;
  bucketCount?: number;
  sampleCount?: number;
  expectedBucketCount?: number;
  ageHours?: number | null;
  currentPositionPct?: number | null;
  requestedHours?: number;
  minimumWindowHours?: number;
  windowHoursUsed?: number;
  score?: number | null;
}

export interface BidZoneCandidate {
  address: string;
  symbol?: string | null;
  name?: string | null;
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

export interface LateralizedPayload {
  generatedAt?: string | null;
  runId?: number;
  requestedHours?: number;
  count: number;
  candidateCount?: number;
  resultCount?: number;
  candidates: LateralizedCandidate[];
}

export interface BidZonePayload {
  generatedAt?: string | null;
  requestedHours?: number;
  minMcap?: number;
  minVol1h?: number;
  minVol24h?: number;
  count: number;
  candidates: BidZoneCandidate[];
}

export interface MeteoraBatchItem {
  address: string;
  tvl?: number | null;
  poolAddress?: string | null;
  poolCount?: number;
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

export function fetchDashboardMonitored(token?: string | null) {
  return apiFetch<DashboardMonitoredPayload>('/api/dashboard/monitored', { token })
    .then((response) => ({
      generatedAt: response.generatedAt ?? null,
      tokens: response.tokens || [],
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

export function fetchLateralizedCandidates(token?: string | null, options?: { limit?: number }) {
  const params = new URLSearchParams();
  if (options?.limit) {
    params.set('limit', String(options.limit));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return apiFetch<LateralizedPayload>(`/api/catalog/lateralized${suffix}`, { token })
    .then((response) => ({
      generatedAt: response.generatedAt ?? null,
      runId: response.runId,
      requestedHours: response.requestedHours,
      count: Number(response.count) || 0,
      candidateCount: response.candidateCount,
      resultCount: response.resultCount,
      candidates: response.candidates || [],
    }));
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
      requestedHours: response.requestedHours,
      minMcap: response.minMcap,
      minVol1h: response.minVol1h,
      minVol24h: response.minVol24h,
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
