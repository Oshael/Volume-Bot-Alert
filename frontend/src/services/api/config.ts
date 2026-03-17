import { apiFetch } from './base';

export interface AddressItem {
  address: string;
  label?: string | null;
}

export interface ConfigPayload {
  configs: Record<string, string | number>;
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
