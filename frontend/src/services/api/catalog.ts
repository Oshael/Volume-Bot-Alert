import { apiFetch } from './base';
import eligibleCatalogCsv from '../../../../token_catalog_eligible.csv?raw';

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

export interface EligibleCatalogToken {
  address: string;
  symbol?: string | null;
  name?: string | null;
  mcap?: number | null;
  lastSeenAt?: string | null;
  lastEvaluatedAt?: string | null;
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

function splitCsvLine(line: string) {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  cells.push(current);
  return cells;
}

function parseEligibleCatalogCsv(raw: string): EligibleCatalogToken[] {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return [];
  }

  const rows: EligibleCatalogToken[] = [];
  for (const line of lines.slice(1)) {
    const [address, symbol, name, eligible, lastMcap, lastSeenAt, lastEvaluatedAt] = splitCsvLine(line);
    if (!address || eligible !== 't') {
      continue;
    }

    const mcap = Number(lastMcap);
    const normalizedMcap = Number.isFinite(mcap) ? mcap : null;
    if (!(normalizedMcap != null && normalizedMcap >= FRONTEND_MONITORED_MIN_MCAP)) {
      continue;
    }

    rows.push({
      address,
      symbol: symbol || null,
      name: name || null,
      mcap: normalizedMcap,
      lastSeenAt: lastSeenAt || null,
      lastEvaluatedAt: lastEvaluatedAt || null,
    });
  }

  return rows;
}

const eligibleCatalogFixture = parseEligibleCatalogCsv(eligibleCatalogCsv);

export function fetchEligibleCatalogFixture() {
  return Promise.resolve([...eligibleCatalogFixture]);
}

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
    })))
    .catch(() => fetchEligibleCatalogFixture());
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
