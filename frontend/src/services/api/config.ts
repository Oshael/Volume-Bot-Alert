import { apiFetch } from './base';
import type { ChainFilterPreferences, TokenChain, WorkspaceChainReadinessMap } from '../../utils/token-chain';

export interface AddressItem {
  chain?: TokenChain;
  address: string;
  label?: string | null;
  imageUrl?: string | null;
  symbol?: string | null;
  name?: string | null;
  last_image_url?: string | null;
  last_price?: number | string | null;
  last_mcap?: number | string | null;
  last_fdv?: number | string | null;
  last_liquidity_usd?: number | string | null;
  last_vol_5m?: number | string | null;
  last_vol_1h?: number | string | null;
  last_vol_6h?: number | string | null;
  last_vol_24h?: number | string | null;
  last_price_change_1h?: number | string | null;
  last_price_change_6h?: number | string | null;
  last_price_change_24h?: number | string | null;
  last_token_created_at_ms?: number | string | null;
  first_seen_at?: string | null;
  last_seen_at?: string | null;
}

export interface AdminTokenReviewAlert {
  id: number;
  chain: TokenChain;
  tokenAddress: string | null;
  status: 'open' | 'resolved' | string | null;
  priority: string | null;
  alertKind: string | null;
  pipeline: string | null;
  label: string | null;
  reasonCodes: string[];
  assessment: Record<string, unknown>;
  socialSnapshot: Record<string, unknown>;
  marketSnapshot: Record<string, unknown>;
  riskSnapshot: Record<string, unknown>;
  meteoraSnapshot: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
  resolvedAt: string | null;
  resolvedBy: number | null;
  resolution: string | null;
  notes: string | null;
}

export type AdminTokenReviewResolution = 'dismiss' | 'block' | 'mark_valid' | 'mark_weak';

export interface ManualTokenFolderPayload {
  id: number;
  userId: number;
  parentFolderId: number | null;
  name: string;
  sortOrder: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ManualTokenFolderItemPayload {
  userId: number;
  folderId: number;
  chain: TokenChain;
  address: string;
  sortOrder: number;
  addedAt: string | null;
}

export interface ManualTokenFoldersPayload {
  folders: ManualTokenFolderPayload[];
  items: ManualTokenFolderItemPayload[];
}

export interface BucketSortCriterionPayload {
  mode: 'vol' | 'mcap' | 'pchange' | 'age';
  window: '1h' | '6h' | '24h' | 'newest' | 'oldest' | 'highest' | 'lowest';
}

export interface MonitoredSortCriterionPayload {
  mode: 'vol' | 'mcap' | 'age';
  window: '5m' | '1h' | '6h' | '24h' | 'newest' | 'oldest' | 'highest' | 'lowest';
}

export type TradeTerminalKey = 'axiom' | 'photon' | 'bullx' | 'gmgn' | 'padre';
export type LiveWorkspacePanelKey = 'monitored' | 'pumpfun' | 'alerts';
export type LiveWorkspacePanelSpan = 1 | 2 | 3;

export interface LivePanelLayoutPayload {
  order: LiveWorkspacePanelKey[];
  spans: {
    monitored: LiveWorkspacePanelSpan;
    pumpfun: 1;
    alerts: LiveWorkspacePanelSpan;
  };
  heights: {
    monitored: number;
    alerts: number;
  };
}

export interface UiPrefsPayload {
  collapsed: {
    manual: boolean;
    recent: boolean;
    oldWeek: boolean;
    monitored: boolean;
    bidZone: boolean;
    pumpfun: boolean;
  };
  manualStarredOnly: boolean;
  manualFolderDeleteWarningDismissed: boolean;
  recentStarredOnly: boolean;
  oldWeekStarredOnly: boolean;
  chainFilters: ChainFilterPreferences;
  monitoredPerPage: number;
  recentPerPage: number;
  oldWeekPerPage: number;
  manualSorts: BucketSortCriterionPayload[];
  recentSorts: BucketSortCriterionPayload[];
  oldWeekSorts: BucketSortCriterionPayload[];
  monitoredSorts: MonitoredSortCriterionPayload[];
  expandedSparklineGranularityMinutes: number;
  expandedSparklineTimeZone: string;
  sparklineRange: {
    global: boolean;
    globalDays: number;
    monitoredDays: number;
    recentDays: number;
    oldWeekDays: number;
    tokenDaysByAddress: Record<string, number>;
  };
  enabledTradeTerminals: TradeTerminalKey[];
  livePanelLayout: LivePanelLayoutPayload;
}

export interface ConfigPayload {
  configs: Record<string, string | number>;
  uiPrefs: UiPrefsPayload;
  tokens: AddressItem[];
  blocklist: AddressItem[];
  starredTokens: Array<{ chain?: TokenChain; address: string }>;
  availableChains?: TokenChain[];
  chainReadiness?: WorkspaceChainReadinessMap;
  runtimeFlags?: {
    mockTradingEnabled?: boolean;
  };
}

export interface ConfigSyncPayload {
  configs?: Record<string, string | number>;
  tokens?: AddressItem[];
  blocklist?: AddressItem[];
  starredTokens?: Array<{ chain?: TokenChain; address: string }>;
}

export function fetchConfig(token?: string | null) {
  return apiFetch<ConfigPayload>('/api/config', { token });
}

export function fetchChainReadiness(token?: string | null) {
  return apiFetch<{
    availableChains: TokenChain[];
    chainReadiness: WorkspaceChainReadinessMap;
  }>('/api/config/chain-readiness', { token });
}

export function fetchManualTokenFolders(token?: string | null) {
  return apiFetch<ManualTokenFoldersPayload>('/api/config/token-folders', { token });
}

export function patchConfig(
  configs: Record<string, string | number>,
  token?: string | null,
) {
  return apiFetch<{ message: string; configs: Record<string, string | number> }>('/api/config', {
    method: 'PATCH',
    body: JSON.stringify({ configs }),
    token,
  });
}

export function patchUiPrefs(
  uiPrefs: Partial<UiPrefsPayload>,
  token?: string | null,
) {
  return apiFetch<{ message: string; uiPrefs: UiPrefsPayload }>('/api/config/ui-prefs', {
    method: 'PATCH',
    body: JSON.stringify({ uiPrefs }),
    token,
  });
}

export function syncConfig(payload: ConfigSyncPayload, token?: string | null) {
  return apiFetch<{ message: string } & ConfigPayload>('/api/config', {
    method: 'PUT',
    body: JSON.stringify(payload),
    token,
  });
}

export function addManualToken(chain: TokenChain, address: string, label?: string | null, token?: string | null) {
  return apiFetch<{ message: string; token: AddressItem & { added_at?: string } }>('/api/config/tokens', {
    method: 'POST',
    body: JSON.stringify({ chain, address, label: label ?? null }),
    token,
  });
}

export function removeManualToken(chain: TokenChain, address: string, token?: string | null) {
  return apiFetch<{ message: string }>(`/api/config/tokens/${encodeURIComponent(address)}?chain=${encodeURIComponent(chain)}`, {
    method: 'DELETE',
    token,
  });
}

export function createManualTokenFolder(
  payload: { name: string; sortOrder?: number },
  token?: string | null,
) {
  return apiFetch<{ message: string; folder: ManualTokenFolderPayload }>('/api/config/token-folders', {
    method: 'POST',
    body: JSON.stringify(payload),
    token,
  });
}

export function updateManualTokenFolder(
  folderId: number,
  payload: { name?: string; sortOrder?: number },
  token?: string | null,
) {
  return apiFetch<{ message: string; folder: ManualTokenFolderPayload }>(`/api/config/token-folders/${encodeURIComponent(String(folderId))}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
    token,
  });
}

export function deleteManualTokenFolder(folderId: number, token?: string | null) {
  return apiFetch<{ message: string; removedTokens: string[]; removedTokenIdentities?: Array<{ chain: TokenChain; address: string }> }>(`/api/config/token-folders/${encodeURIComponent(String(folderId))}`, {
    method: 'DELETE',
    token,
  });
}

export function addManualTokenToFolder(
  folderId: number,
  chain: TokenChain,
  address: string,
  token?: string | null,
  sortOrder?: number,
) {
  return apiFetch<{ message: string; item: ManualTokenFolderItemPayload; tokenCreated?: boolean }>(`/api/config/token-folders/${encodeURIComponent(String(folderId))}/tokens`, {
    method: 'POST',
    body: JSON.stringify({ chain, address, sortOrder }),
    token,
  });
}

export function removeManualTokenFromFolder(folderId: number, chain: TokenChain, address: string, token?: string | null) {
  return apiFetch<{ message: string }>(
    `/api/config/token-folders/${encodeURIComponent(String(folderId))}/tokens/${encodeURIComponent(address)}?chain=${encodeURIComponent(chain)}`,
    {
      method: 'DELETE',
      token,
    },
  );
}

export function addBlockedToken(chain: TokenChain, address: string, label?: string | null, token?: string | null) {
  return apiFetch<{ message: string; blocked: AddressItem }>('/api/config/blocklist', {
    method: 'POST',
    body: JSON.stringify({ chain, address, label: label ?? null }),
    token,
  });
}

export function removeBlockedToken(chain: TokenChain, address: string, token?: string | null) {
  return apiFetch<{ message: string }>(`/api/config/blocklist/${encodeURIComponent(address)}?chain=${encodeURIComponent(chain)}`, {
    method: 'DELETE',
    token,
  });
}

export function addStarredToken(chain: TokenChain, address: string, token?: string | null) {
  return apiFetch<{ message: string }>('/api/config/starred', {
    method: 'POST', body: JSON.stringify({ chain, address }), token,
  });
}

export function removeStarredToken(chain: TokenChain, address: string, token?: string | null) {
  return apiFetch<{ message: string }>(`/api/config/starred/${encodeURIComponent(address)}?chain=${encodeURIComponent(chain)}`, {
    method: 'DELETE', token,
  });
}

export function fetchAdminTokenReviewAlerts(token?: string | null, status: 'open' | 'resolved' = 'open') {
  return apiFetch<{ alerts: AdminTokenReviewAlert[]; count: number }>(`/api/admin/token-review-alerts?status=${encodeURIComponent(status)}&limit=100`, {
    token,
  });
}

export function resolveAdminTokenReviewAlert(
  id: number,
  resolution: AdminTokenReviewResolution,
  token?: string | null,
  notes?: string | null,
) {
  return apiFetch<{ message: string; alert: AdminTokenReviewAlert | null }>(`/api/admin/token-review-alerts/${encodeURIComponent(String(id))}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ resolution, notes: notes ?? null }),
    token,
  });
}
