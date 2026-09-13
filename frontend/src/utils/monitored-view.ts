import type { TokenChain } from './token-chain';

export const MONITORED_VIEW_IDS = [
  'trending',
  'migrated',
  'pre_bonded',
  'watchlist',
] as const;

export const DASHBOARD_SYSTEM_TOKEN_VIEW_IDS = [
  'trending',
  'migrated',
  'pre_bonded',
] as const;

export const DASHBOARD_TOKEN_VIEW_MAX_LIMIT = 40;
export const DASHBOARD_TOKEN_VIEW_RELEASE_CHAINS = ['robinhood'] as const satisfies readonly TokenChain[];

export type MonitoredViewId = typeof MONITORED_VIEW_IDS[number];
export type DashboardSystemTokenViewId = typeof DASHBOARD_SYSTEM_TOKEN_VIEW_IDS[number];
export type MonitoredSystemViewStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'syncing'
  | 'unavailable'
  | 'unsupported'
  | 'error';

export interface MonitoredPaneState {
  view: MonitoredViewId;
  searchQuery: string;
  scrollAnchor: string | null;
}

export interface MonitoredSystemViewState {
  status: MonitoredSystemViewStatus;
  tokenIdentities: string[];
  metadataByIdentity: Record<string, MonitoredSystemViewTokenMetadata>;
  generatedAt: string | null;
  error: string | null;
}

export interface MonitoredSystemViewTokenMetadata {
  rank: number | null;
  score: number | null;
  scoreVersion: string | null;
  lifecycleStatus: 'migrated' | 'pre_bonded' | null;
  bondProgressBps: number | null;
}

export function createMonitoredPaneState(view: MonitoredViewId = 'trending'): MonitoredPaneState {
  return {
    view,
    searchQuery: '',
    scrollAnchor: null,
  };
}

export function createMonitoredSystemViewStates(): Record<
  DashboardSystemTokenViewId,
  MonitoredSystemViewState
> {
  const createState = (): MonitoredSystemViewState => ({
    status: 'idle',
    tokenIdentities: [],
    metadataByIdentity: {},
    generatedAt: null,
    error: null,
  });
  return {
    trending: createState(),
    migrated: createState(),
    pre_bonded: createState(),
  };
}

export function resolveDashboardTokenViewRequest(view: MonitoredViewId) {
  if (!isDashboardSystemTokenViewId(view)) return null;
  return {
    view,
    options: {
      chains: [...DASHBOARD_TOKEN_VIEW_RELEASE_CHAINS],
      limit: DASHBOARD_TOKEN_VIEW_MAX_LIMIT,
    },
  };
}

export interface DashboardTokenViewRequestOptions {
  chains?: TokenChain[];
  limit?: number;
  asOf?: string;
}

export function isMonitoredViewId(value: unknown): value is MonitoredViewId {
  return MONITORED_VIEW_IDS.includes(value as MonitoredViewId);
}

export function isDashboardSystemTokenViewId(
  value: unknown,
): value is DashboardSystemTokenViewId {
  return DASHBOARD_SYSTEM_TOKEN_VIEW_IDS.includes(value as DashboardSystemTokenViewId);
}

export function normalizeMonitoredViewId(
  value: unknown,
  fallback: MonitoredViewId = 'trending',
): MonitoredViewId {
  return isMonitoredViewId(value) ? value : fallback;
}

function normalizeViewChains(value: unknown): TokenChain[] {
  const chains: TokenChain[] = [];
  for (const item of Array.isArray(value) ? value : ['robinhood']) {
    const chain = String(item || '').trim().toLowerCase() as TokenChain;
    if (chain && !chains.includes(chain)) chains.push(chain);
  }
  if (chains.length === 0) throw new RangeError('token view requires at least one chain');
  return chains;
}

export function buildDashboardTokenViewPath(
  view: DashboardSystemTokenViewId,
  options: DashboardTokenViewRequestOptions = {},
) {
  if (!isDashboardSystemTokenViewId(view)) {
    throw new RangeError('unsupported dashboard system token view');
  }
  const limit = options.limit ?? DASHBOARD_TOKEN_VIEW_MAX_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DASHBOARD_TOKEN_VIEW_MAX_LIMIT) {
    throw new RangeError(`token view limit must be between 1 and ${DASHBOARD_TOKEN_VIEW_MAX_LIMIT}`);
  }
  const query = new URLSearchParams({
    chains: normalizeViewChains(options.chains).join(','),
    limit: String(limit),
  });
  const asOf = String(options.asOf || '').trim();
  if (asOf) query.set('asOf', asOf);
  return `/api/dashboard/token-views/${view}?${query.toString()}`;
}
