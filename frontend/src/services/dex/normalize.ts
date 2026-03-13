import type { ManualTokenEntry } from '../../state/app-state';

interface DexPairLike {
  chainId?: string;
  liquidity?: { usd?: number | string | null };
  baseToken?: { address?: string | null; symbol?: string | null; name?: string | null; logoUri?: string | null };
  info?: { imageUrl?: string | null; header?: string | null; socials?: Array<{ type?: string | null; url?: string | null }> | null }; 
  marketCap?: number | string | null;
  fdv?: number | string | null;
  priceUsd?: number | string | null;
  pairCreatedAt?: number | string | null;
  volume?: { m5?: number | string | null; h1?: number | string | null; h6?: number | string | null; h24?: number | string | null };
  priceChange?: { h1?: number | string | null; h6?: number | string | null; h24?: number | string | null };
  url?: string | null;
  pairAddress?: string | null;
}


function toNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function normalizeManualDexPayload(address: string, payload: any): Partial<ManualTokenEntry> | null {
  const rawPairs = Array.isArray(payload?.pairs)
    ? payload.pairs
    : Array.isArray(payload?.data?.pairs)
      ? payload.data.pairs
      : Array.isArray(payload?.data?.data?.pairs)
        ? payload.data.data.pairs
        : [];
  const pairs = rawPairs as DexPairLike[];
  const solanaPairs = pairs.filter((pair: DexPairLike) => pair?.chainId === 'solana');
  const ranked = (solanaPairs.length ? solanaPairs : pairs)
    .slice()
    .sort((a: DexPairLike, b: DexPairLike) => (Number(b?.liquidity?.usd) || 0) - (Number(a?.liquidity?.usd) || 0));

  const pair = ranked[0];
  if (!pair) return null;

  return {
    address,
    mintAddress: pair.baseToken?.address || address,
    pairAddress: pair.pairAddress || null,
    symbol: pair.baseToken?.symbol || null,
    name: pair.baseToken?.name || null,
    pairUrl: pair.url || null,
    imageUrl: pair.info?.imageUrl || pair.info?.header || pair.baseToken?.logoUri || null,
    twitterUrl: pair.info?.socials?.find((social) => String(social?.type || '').toLowerCase().includes('twitter'))?.url || null,
    createdAt: toNumber(pair.pairCreatedAt),
    mcap: toNumber(pair.marketCap) ?? toNumber(pair.fdv),
    priceUsd: toNumber(pair.priceUsd),
    volume5m: toNumber(pair.volume?.m5),
    volume1h: toNumber(pair.volume?.h1),
    volume6h: toNumber(pair.volume?.h6),
    volume24h: toNumber(pair.volume?.h24),
    priceChange1h: toNumber(pair.priceChange?.h1),
    priceChange6h: toNumber(pair.priceChange?.h6),
    priceChange24h: toNumber(pair.priceChange?.h24),
  };
}

