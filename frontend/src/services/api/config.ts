import { apiFetch } from './base';

export interface AddressItem {
  address: string;
  label?: string | null;
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
}

export interface UiPrefsPayload {
  collapsed: {
    manual: boolean;
    recent: boolean;
    oldWeek: boolean;
    monitored: boolean;
    lateralized: boolean;
    bidZone: boolean;
    pumpfun: boolean;
  };
  manualStarredOnly: boolean;
  recentStarredOnly: boolean;
  oldWeekStarredOnly: boolean;
  monitoredPerPage: number;
  recentPerPage: number;
  oldWeekPerPage: number;
  manualSorts: BucketSortCriterionPayload[];
  recentSorts: BucketSortCriterionPayload[];
  oldWeekSorts: BucketSortCriterionPayload[];
  monitoredSorts: MonitoredSortCriterionPayload[];
  enabledTradeTerminals: TradeTerminalKey[];
  livePanelLayout: LivePanelLayoutPayload;
}

export interface ConfigPayload {
  configs: Record<string, string | number>;
  uiPrefs: UiPrefsPayload;
  tokens: AddressItem[];
  blocklist: AddressItem[];
  starredTokens: Array<{ address: string }>;
}

export interface ConfigSyncPayload {
  configs?: Record<string, string | number>;
  tokens?: AddressItem[];
  blocklist?: AddressItem[];
  starredTokens?: Array<{ address: string }>;
}

export function fetchConfig(token?: string | null) {
  return apiFetch<ConfigPayload>('/api/config', { token });
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

export function addManualToken(address: string, label?: string | null, token?: string | null) {
  return apiFetch<{ message: string; token: AddressItem & { added_at?: string } }>('/api/config/tokens', {
    method: 'POST',
    body: JSON.stringify({ address, label: label ?? null }),
    token,
  });
}

export function removeManualToken(address: string, token?: string | null) {
  return apiFetch<{ message: string }>(`/api/config/tokens/${encodeURIComponent(address)}`, {
    method: 'DELETE',
    token,
  });
}

export function addBlockedToken(address: string, label?: string | null, token?: string | null) {
  return apiFetch<{ message: string; blocked: AddressItem }>('/api/config/blocklist', {
    method: 'POST',
    body: JSON.stringify({ address, label: label ?? null }),
    token,
  });
}

export function removeBlockedToken(address: string, token?: string | null) {
  return apiFetch<{ message: string }>(`/api/config/blocklist/${encodeURIComponent(address)}`, {
    method: 'DELETE',
    token,
  });
}
