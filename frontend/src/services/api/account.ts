import { apiFetch } from './base';
import type { AuthEmailDebug, SessionUser } from './auth';

export interface AccountAccessPayload {
  accessStatus: 'inactive' | 'active' | 'grace' | 'revoked';
  accessGrantedAt: string | null;
  accessExpiresAt: string | null;
  accessSource: 'manual' | 'payment' | 'admin' | 'promo' | 'invite' | 'token';
  accessUpdatedAt: string | null;
  isExpired: boolean;
  isTimed: boolean;
  hasProductAccess: boolean;
  denialReason: string | null;
  denialCode: string | null;
  daysRemaining: number | null;
  accessReason?: string | null;
  tokenTier?: 'unlimited' | 'discount_50' | 'launch_free' | 'none' | string;
  discountPercent?: number;
  tokenBalanceRaw?: string | null;
  tokenBalanceUi?: string | null;
  tokenSnapshotCheckedAt?: string | null;
  tokenSnapshotExpiresAt?: string | null;
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
  canUnlink: boolean;
  unlinkBlockedReason: string | null;
}

export interface AccountIdentitiesPayload {
  providers: AccountIdentityProviderPayload[];
  hasPasswordLogin: boolean;
}

export interface UnlinkAccountIdentityPayload extends AccountIdentitiesPayload {
  message: string;
  scope: 'pre_access' | 'authenticated';
}

export interface UpdateAccountProfileInput {
  username: string;
  email?: string;
  password?: string;
  confirmPassword?: string;
}

export interface UpdateAccountProfilePayload {
  message: string;
  user: SessionUser;
  emailVerificationRequired: boolean;
  emailDebug: AuthEmailDebug | null;
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

export function updateAccountProfile(input: UpdateAccountProfileInput, token?: string | null) {
  return apiFetch<UpdateAccountProfilePayload>('/api/account/profile', {
    method: 'PATCH',
    token,
    body: JSON.stringify(input),
  });
}
