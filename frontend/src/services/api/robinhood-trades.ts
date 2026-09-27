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
  scope: RobinhoodTradeScope;
  creatorAddress: string | null;
  trades: RobinhoodTrade[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface FetchRobinhoodTokenTradesParams {
  token: string;
  scope?: RobinhoodTradeScope;
  cursor?: string | null;
  limit?: number;
}

export type RobinhoodTradeScope = 'all' | 'dev';

export type RobinhoodWalletTradeSide = 'all' | 'buy' | 'sell';

export interface RobinhoodWalletTrade {
  chain: 'robinhood';
  walletAddress: string;
  tokenAddress: string;
  transactionHash: string;
  actionIndex: number;
  blockNumber: number;
  blockTime: string;
  side: 'buy' | 'sell';
  tokenAmount: string | null;
  tokenAmountRaw: string;
  tokenDecimals: number | null;
  amountUsd: number | null;
  priceUsd: number | null;
}

export interface RobinhoodWalletTradesPage {
  chain: 'robinhood';
  wallet: string;
  side: RobinhoodWalletTradeSide;
  trades: RobinhoodWalletTrade[];
  hasMore: boolean;
  nextCursor: string | null;
}

export function fetchRobinhoodWalletTrades(
  params: { wallet: string; side: RobinhoodWalletTradeSide; cursor?: string | null; limit?: number },
  authToken?: string | null,
) {
  const query = new URLSearchParams({ wallet: params.wallet, side: params.side });
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));
  return apiFetch<RobinhoodWalletTradesPage>(`/api/robinhood/wallet-trades?${query.toString()}`, {
    method: 'GET', token: authToken ?? null,
  });
}

// GET /api/robinhood/trades — recent per-swap trades for one Robinhood token.
// Authenticated + Robinhood-visibility gated on the server; the panel is only
// mounted for the Robinhood chain, so a hidden-Robinhood user never calls this.
export function fetchRobinhoodTokenTrades(
  params: FetchRobinhoodTokenTradesParams,
  authToken?: string | null,
) {
  const query = new URLSearchParams({ token: params.token });
  if (params.scope && params.scope !== 'all') {
    query.set('scope', params.scope);
  }
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
