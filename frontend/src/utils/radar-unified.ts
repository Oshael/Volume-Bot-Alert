import type { BucketSortCriterion } from '../state/app-state';
import type { DashboardRadarBootstrapRequest } from '../services/api/catalog';
import { parseTokenIdentityKey } from './token-chain.ts';

const MAX_PREFIX = 500;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function resolveUnifiedRadarAgeTone(createdAt: number | null | undefined, asOf: string | null): 'recent' | 'old' | 'unknown' {
  const reference = asOf ? Date.parse(asOf) : Date.now();
  if (!Number.isFinite(createdAt) || !createdAt || !Number.isFinite(reference) || createdAt > reference) {
    return 'unknown';
  }
  return reference - createdAt <= SEVEN_DAYS_MS ? 'recent' : 'old';
}

export interface RadarUnifiedState {
  tokenIdentities: string[];
  total: number;
  asOf: string | null;
  page: number;
  perPage: number;
  searchQuery: string;
  starredOnly: boolean;
  sorts: BucketSortCriterion[];
  ageMinMinutes: number;
  ageMaxMinutes: number | null;
  minMcap: number;
  maxMcap: number;
  minFdv: number;
  maxFdv: number;
  loading: boolean;
  error: string | null;
}

export function createRadarUnifiedState(): RadarUnifiedState {
  return {
    tokenIdentities: [],
    total: 0,
    asOf: null,
    page: 0,
    perPage: 15,
    searchQuery: '',
    starredOnly: false,
    sorts: [{ mode: 'vol', window: '1h' }, { mode: 'vol', window: '6h' }],
    ageMinMinutes: 0,
    ageMaxMinutes: null,
    minMcap: 120_000,
    maxMcap: 100_000_000,
    minFdv: 120_000,
    maxFdv: 100_000_000,
    loading: false,
    error: null,
  };
}

function robinhoodIdentities(values: string[]): string[] {
  const identities = new Set<string>();
  for (const value of values) {
    try {
      const identity = parseTokenIdentityKey(value);
      if (identity.chain === 'robinhood') identities.add(identity.key);
    } catch (_) {
      // Ignore corrupt old preferences instead of failing the Radar request.
    }
  }
  return [...identities];
}

export function buildRadarUnifiedRequest(
  state: RadarUnifiedState,
  identities: { starred: string[]; dismissed: string[]; pinned?: string[] },
): DashboardRadarBootstrapRequest {
  const perPage = Math.min(100, Math.max(10, Math.floor(state.perPage) || 15));
  const page = Math.min(Math.max(0, Math.floor(state.page) || 0), Math.floor(MAX_PREFIX / perPage) - 1);
  return {
    page,
    perPage,
    searchQuery: state.searchQuery.trim(),
    starredOnly: state.starredOnly,
    sorts: state.sorts,
    ageMinMinutes: state.ageMinMinutes,
    ...(state.ageMaxMinutes == null ? {} : { ageMaxMinutes: state.ageMaxMinutes }),
    minMcap: state.minMcap,
    maxMcap: state.maxMcap,
    minFdv: state.minFdv,
    maxFdv: state.maxFdv,
    starredIdentities: robinhoodIdentities(identities.starred),
    dismissedIdentities: robinhoodIdentities(identities.dismissed),
    pinnedIdentities: robinhoodIdentities(identities.pinned ?? []),
  };
}
