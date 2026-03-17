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
  lastSeenAt?: string | null;
  lastEvaluatedAt?: string | null;
  meteora?: MeteoraBatchItem | null;
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
  return apiFetch<{ tokens: DashboardMonitoredToken[] }>('/api/dashboard/monitored', { token })
    .then((response) => response.tokens || []);
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

export function fetchMeteoraBatch(addresses: string[], token?: string | null) {
  return apiFetch<{
    items: MeteoraBatchItem[];
    count: number;
  }>('/api/catalog/meteora/batch', {
    method: 'POST',
    body: JSON.stringify({ addresses }),
    token,
  }).then((response) => response.items || []);
}
