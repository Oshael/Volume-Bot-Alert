import { apiFetch } from '../api/base';

export type ChartWalletBuy = {
  evidenceId: string;
  evidenceState: 'wallet_action';
  correlationStatus: 'not_evaluated';
  profile: {
    platform: 'pump' | 'fomo';
    platformUserId: string;
    username: string | null;
    displayName: string | null;
    profilePictureUrl: string | null;
  };
  walletBinding: {
    address: string;
    networkScope: 'exact_chain' | 'evm_address_candidate';
    sourceType: string;
    confidence: string | null;
  };
  action: {
    blockTime: string;
    transactionHash: string;
    amountUsd: number | null;
    priceUsd: number | null;
  };
};

type WalletBuyPayload = {
  status: 'ready' | 'pending';
  actions: ChartWalletBuy[];
  hasMore: boolean;
};

export type ChartWalletBuyCandle = { time: number; low: number };
export type ChartWalletBuyGroup = {
  id: string;
  bucketStart: number;
  x: number;
  y: number;
  actions: ChartWalletBuy[];
};

type WalletBuyScale = {
  timeToCoordinate(time: number): number | null;
  priceToCoordinate(price: number): number | null;
};

const CACHE_MS = 30_000;
const cache = new Map<string, { expiresAt: number; request: Promise<{ actions: ChartWalletBuy[]; truncated: boolean }> }>();

export function groupChartWalletBuys(
  actions: ChartWalletBuy[],
  candles: ChartWalletBuyCandle[],
  scale: WalletBuyScale,
  granularityMinutes: number,
) {
  const seconds = Math.max(60, Math.round(granularityMinutes || 5) * 60);
  const candleByTime = new Map(candles.map((candle) => [candle.time, candle]));
  const grouped = new Map<number, ChartWalletBuy[]>();
  for (const action of actions) {
    const timestamp = Date.parse(action.action.blockTime) / 1000;
    const bucket = Math.floor(timestamp / seconds) * seconds;
    if (!Number.isFinite(timestamp) || !candleByTime.has(bucket)) continue;
    grouped.set(bucket, [...(grouped.get(bucket) || []), action]);
  }
  const groups: ChartWalletBuyGroup[] = [];
  for (const [bucketStart, bucketActions] of grouped) {
    const candle = candleByTime.get(bucketStart);
    const x = scale.timeToCoordinate(bucketStart);
    const priceY = candle ? scale.priceToCoordinate(candle.low) : null;
    if (x == null || priceY == null || !Number.isFinite(x) || !Number.isFinite(priceY)) continue;
    groups.push({
      id: `wallet-buys:${bucketStart}`,
      bucketStart,
      x,
      y: priceY + 24,
      actions: bucketActions.sort((left, right) => (
        Date.parse(right.action.blockTime) - Date.parse(left.action.blockTime)
      )),
    });
  }
  return groups.sort((left, right) => left.bucketStart - right.bucketStart);
}

export function fetchChartWalletBuys(address: string, token?: string | null) {
  const cached = cache.get(address);
  if (cached && cached.expiresAt > Date.now()) return cached.request;
  const to = new Date();
  const query = new URLSearchParams({
    chain: 'robinhood', token: address,
    from: new Date(to.getTime() - (72 * 60 * 60 * 1000)).toISOString(),
    to: to.toISOString(), limit: '200',
  });
  const request = apiFetch<WalletBuyPayload>(`/api/callouts/profile-wallet-buys?${query}`, { token })
    .then((payload) => ({
      actions: payload.status === 'ready' && Array.isArray(payload.actions) ? payload.actions : [],
      truncated: Boolean(payload.hasMore),
    }))
    .catch((error) => { cache.delete(address); throw error; });
  cache.set(address, { expiresAt: Date.now() + CACHE_MS, request });
  return request;
}
