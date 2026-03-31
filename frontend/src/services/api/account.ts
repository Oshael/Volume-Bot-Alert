import { apiFetch } from './base';

export interface AccountAccessPayload {
  accessStatus: 'inactive' | 'active' | 'grace' | 'revoked';
  accessGrantedAt: string | null;
  accessExpiresAt: string | null;
  accessSource: 'manual' | 'payment' | 'admin' | 'promo' | 'invite';
  accessUpdatedAt: string | null;
  isExpired: boolean;
  isTimed: boolean;
  hasProductAccess: boolean;
  denialReason: string | null;
  denialCode: string | null;
  daysRemaining: number | null;
}

export interface AccountIdentityProviderPayload {
  provider: 'google' | 'discord';
  label: string;
  configured: boolean;
  linked: boolean;
  providerEmail: string | null;
  providerEmailVerified: boolean;
  providerDisplayName: string | null;
  linkedAt: string | null;
  lastLoginAt: string | null;
}

export interface AccountIdentitiesPayload {
  providers: AccountIdentityProviderPayload[];
}

export interface UnlinkAccountIdentityPayload extends AccountIdentitiesPayload {
  message: string;
  scope: 'pre_access' | 'authenticated';
}

export function fetchAccountAccess(token?: string | null) {
  return apiFetch<AccountAccessPayload>('/api/account/access', { token });
}

export function fetchAccountIdentities(token?: string | null) {
  return apiFetch<AccountIdentitiesPayload>('/api/account/identities', { token });
}

export function fetchAccountSecurityIdentities(token?: string | null) {
  return apiFetch<AccountIdentitiesPayload>('/api/account-security/identities', { token });
}

export function unlinkAccountSecurityIdentity(
  provider: 'google' | 'discord',
  currentPassword: string,
  token?: string | null,
) {
  return apiFetch<UnlinkAccountIdentityPayload>(`/api/account-security/identities/${encodeURIComponent(provider)}/unlink`, {
    method: 'POST',
    token,
    body: JSON.stringify({ currentPassword }),
  });
}
