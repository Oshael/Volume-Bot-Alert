import { apiFetch } from './base';

export interface RobinhoodHolder {
  rank: number;
  address: string;
  balanceRaw: string;
  addressType: 'wallet' | 'contract' | 'pool' | 'burn' | 'unknown';
  label: string | null;
  isVerifiedContract: boolean;
}

export interface RobinhoodHolderSummary {
  holderCount: number | null;
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

export interface RobinhoodHolderHistoryPoint {
  date: string;
  holderCount: number;
  observedAt: string;
  delta24h: number | null;
  delta24hPct: number | null;
  comparison: 'complete' | 'unavailable';
}

export interface RobinhoodHolderHistory {
  token: string;
  days: number;
  asOf: string;
  baseline: Omit<RobinhoodHolderHistoryPoint, 'delta24h' | 'delta24hPct' | 'comparison'> | null;
  points: RobinhoodHolderHistoryPoint[];
}

export function fetchRobinhoodHoldersPage(token: string, cursor?: string | null, authToken?: string | null) {
  const query = new URLSearchParams({ token });
  if (cursor) query.set('cursor', cursor);
  return apiFetch<RobinhoodHoldersPage>(`/api/robinhood/holders?${query}`, {
    method: 'GET', token: authToken ?? null,
  });
}

export function fetchRobinhoodHolderHistory(token: string, authToken?: string | null) {
  const query = new URLSearchParams({ token, days: '30' });
  return apiFetch<RobinhoodHolderHistory>(`/api/robinhood/holder-history?${query}`, {
    method: 'GET', token: authToken ?? null,
  });
}
