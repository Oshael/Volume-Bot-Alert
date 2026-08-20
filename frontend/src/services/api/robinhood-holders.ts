import { apiFetch } from './base';

export interface RobinhoodHolder {
  rank: number;
  address: string;
  balanceRaw: string;
  addressType: 'wallet' | 'contract' | 'pool' | 'burn' | 'unknown';
  label: string | null;
  isVerifiedContract: boolean;
  nativeBalanceRaw?: string | null;
  avgBuyMcapUsd?: string | null;
  avgSellMcapUsd?: string | null;
  buyTxCount?: number | null;
  sellTxCount?: number | null;
  realizedPnlUsd?: string | null;
  unrealizedPnlUsd?: string | null;
  unrealizedPnlPct?: string | null;
  currentValueUsd?: string | null;
  positionQuality?: string | null;
  costBasisSource?: string | null;
}

export interface RobinhoodHolderSummary {
  holderCount: number | null;
  totalSupplyRaw: string | null;
  source: 'ledger_live' | 'blockscout';
  observedAt: string | null;
  checkedAt: string | null;
  freshness: 'fresh' | 'stale' | 'unavailable';
}

export interface RobinhoodHoldersPage {
  token: string;
  summary: RobinhoodHolderSummary;
  holders: RobinhoodHolder[];
  hasMore: boolean;
  nextCursor: string | null;
  observedAt: string;
  refreshQueued: boolean;
}

export type RobinhoodHolderInterval = '1h' | '4h' | '12h' | '24h';

export interface RobinhoodHolderBar {
  start: string;
  end: string;
  holderCount: number | null;
  observedAt: string | null;
  delta: number | null;
  status: 'open' | 'complete';
  comparison: 'complete' | 'unavailable';
}

export interface RobinhoodHolderDelta {
  delta: number | null;
  comparison: 'complete' | 'unavailable';
  from: string;
  through: string | null;
}

export interface RobinhoodHolderCountSeries {
  token: string;
  asOf: string;
  resolution: '1h';
  intervals: RobinhoodHolderInterval[];
  range: { start: string | null; through: string; bucketCount: number };
  current: { holderCount: number; source: 'ledger_live' | 'blockscout'; observedAt: string } | null;
  deltas: Record<'4h' | '12h' | '1d' | '3d' | '7d', RobinhoodHolderDelta>;
  series: Record<RobinhoodHolderInterval, RobinhoodHolderBar[]>;
}

export function fetchRobinhoodHoldersPage(token: string, cursor?: string | null, authToken?: string | null) {
  const query = new URLSearchParams({ token });
  if (cursor) query.set('cursor', cursor);
  return apiFetch<RobinhoodHoldersPage>(`/api/robinhood/holders?${query}`, {
    method: 'GET', token: authToken ?? null,
  });
}

export function fetchRobinhoodHolderCountSeries(token: string, authToken?: string | null) {
  const query = new URLSearchParams({ token });
  return apiFetch<RobinhoodHolderCountSeries>(`/api/robinhood/holder-count-series?${query}`, {
    method: 'GET', token: authToken ?? null,
  });
}
