import { apiFetch } from './base';

export type GainersCoverage = 'complete' | 'partial' | 'unavailable';
export interface RadarGainer {
  identity: { chain: 'robinhood'; address: string; key: string };
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  createdAt: number;
  priceChangePct: string;
  priceBasis: { type: 'first-observed-price'; coverage: 'available-history'; observedAt: string };
  volume24hUsd: number | null;
  volume24hCoverage: GainersCoverage;
  volume24hChangePct: number | null;
  volume24hChangeCoverage: GainersCoverage;
  liquidityUsd: number | null;
  liquidityCoverage: GainersCoverage;
  liquidityProjectionCommittedAt?: string | null;
  holderCount: number | null;
  holderFreshness: 'fresh' | 'stale' | 'unavailable';
  holderObservedAt?: string | null;
  holderCheckedAt?: string | null;
}
export interface RadarGainersPage {
  chain: 'robinhood';
  asOf: string;
  volumeAsOf?: string;
  generatedAt: string;
  total: number;
  candidateCount: number;
  unpricedCount: number;
  items: RadarGainer[];
}

export async function fetchRobinhoodRadarGainers(dismissedIdentities: string[], token: string | null, signal: AbortSignal) {
  let retryAfterMs = 10000;
  try {
    return await apiFetch<RadarGainersPage>('/api/robinhood/radar-gainers', {
      method: 'POST', token, signal, body: JSON.stringify({ limit: 15, dismissedIdentities }),
      onResponse: ({ retryAfter }) => {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds > 0) retryAfterMs = Math.min(300000, seconds * 1000);
      },
    });
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error('Gainers unavailable'), { retryAfterMs });
  }
}
