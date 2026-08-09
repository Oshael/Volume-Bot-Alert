import { apiFetch } from './base';

export interface RobinhoodTrade {
  chain: string;
  transactionHash: string;
  actionIndex: number;
  blockNumber: number;
  blockTime: string;
  side: 'buy' | 'sell';
  walletAddress: string;
  amountUsd: number | null;
  priceUsd: number | null;
  mcUsd: number | null;
}

export interface RobinhoodTradesPage {
  chain: string;
  token: string;
  trades: RobinhoodTrade[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface FetchRobinhoodTokenTradesParams {
  token: string;
  cursor?: string | null;
  limit?: number;
}

// GET /api/robinhood/trades — recent per-swap trades for one Robinhood token.
// Authenticated + Robinhood-visibility gated on the server; the panel is only
// mounted for the Robinhood chain, so a hidden-Robinhood user never calls this.
export function fetchRobinhoodTokenTrades(
  params: FetchRobinhoodTokenTradesParams,
  authToken?: string | null,
) {
  const query = new URLSearchParams({ token: params.token });
  if (params.cursor) {
    query.set('cursor', params.cursor);
  }
  if (params.limit) {
    query.set('limit', String(params.limit));
  }
  return apiFetch<RobinhoodTradesPage>(`/api/robinhood/trades?${query.toString()}`, {
    method: 'GET',
    token: authToken ?? null,
  });
}
