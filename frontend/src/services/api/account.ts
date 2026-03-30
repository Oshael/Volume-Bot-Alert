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

export function fetchAccountAccess(token?: string | null) {
  return apiFetch<AccountAccessPayload>('/api/account/access', { token });
}
