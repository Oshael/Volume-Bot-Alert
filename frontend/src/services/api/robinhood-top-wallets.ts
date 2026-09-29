import { apiFetch } from './base';

export type TopWalletWindow = '24h' | '7d' | '30d' | 'ALL';

export interface TopWalletProfile {
  platform: string;
  displayName: string | null;
  username: string | null;
  profilePictureUrl: string | null;
}

export interface TopWalletRow {
  rank: number;
  chainKey: 'robinhood';
  walletAddress: string;
  gainUsd: string;
  openPositionCount: number;
  profile: TopWalletProfile | null;
}

export interface TopWalletPage {
  chainKey: 'robinhood';
  window: TopWalletWindow;
  asOf: string;
  coverage: 'complete' | 'partial';
  rankingIsComplete: boolean;
  reasons: string[];
  excludedWalletCount: number;
  rankingListTruncated: boolean | null;
  profileStatus: 'available' | 'unavailable';
  items: TopWalletRow[];
  hasMore: boolean;
  nextCursor: string | null;
}

export function fetchRobinhoodTopWallets(
  params: { window: TopWalletWindow; asOf?: string | null; cursor?: string | null },
  authToken?: string | null,
) {
  const query = new URLSearchParams({ window: params.window, limit: '25' });
  if (params.asOf) query.set('asOf', params.asOf);
  if (params.cursor) query.set('cursor', params.cursor);
  return apiFetch<TopWalletPage>(`/api/robinhood/top-wallets?${query.toString()}`, {
    method: 'GET', token: authToken ?? null,
  });
}
