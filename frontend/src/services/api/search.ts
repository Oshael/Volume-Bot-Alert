import { apiFetch } from './base';
import type { TokenChain } from '../../utils/token-chain';

export type GlobalSearchAvailability = 'ready' | 'syncing' | 'unavailable' | 'unsupported';
export interface GlobalSearchHit {
  kind: 'token' | 'wallet';
  chain: TokenChain;
  address: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  destination: { type: 'expanded-chart'; chain: TokenChain; address: string };
  match: 'exact_address' | 'exact_ticker' | 'prefix' | 'text';
}
export interface GlobalSearchPayload {
  query: string;
  status: GlobalSearchAvailability;
  chainStates: Record<string, { kinds: Partial<Record<'token' | 'wallet', GlobalSearchAvailability>> }>;
  count: number;
  hits: GlobalSearchHit[];
}

export function fetchGlobalSearch(query: string, token: string | null, signal?: AbortSignal) {
  const params = new URLSearchParams({ q: query, kinds: 'token,wallet', limit: '10' });
  return apiFetch<GlobalSearchPayload>(`/api/search/global?${params}`, { token, signal });
}
