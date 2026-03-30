import { apiFetch } from './base';
import type { AccountAccessPayload } from './account';
import type { SessionUser } from './auth';
import type { BillingOrderEntry, BillingPlanEntry } from '../../state/app-state';

export interface PreAccessMePayload {
  user: SessionUser;
  access: AccountAccessPayload;
  returnUrl: string | null;
}

export interface PreAccessBillingStatePayload {
  enabled: boolean;
  provider: string;
  providerReady: boolean;
  providerMocked: boolean;
  plans: BillingPlanEntry[];
  orders: BillingOrderEntry[];
}

export interface PreAccessCreateOrderResponse {
  message: string;
  order: BillingOrderEntry;
  checkoutUrl: string | null;
}

export interface PreAccessCompleteResponse {
  message: string;
  user: SessionUser;
}

export function fetchPreAccessMe() {
  return apiFetch<PreAccessMePayload>('/api/pre-access/me', { token: null });
}

export function fetchPreAccessBillingState() {
  return apiFetch<PreAccessBillingStatePayload>('/api/pre-access/billing/state', { token: null });
}

export function createPreAccessOrder(planKey: string) {
  return apiFetch<PreAccessCreateOrderResponse>('/api/pre-access/billing/orders', {
    method: 'POST',
    body: JSON.stringify({ planKey }),
    token: null,
  });
}

export function completePreAccessSession() {
  return apiFetch<PreAccessCompleteResponse>('/api/pre-access/complete', {
    method: 'POST',
    token: null,
  });
}

export function logoutPreAccessSession() {
  return apiFetch<{ message: string }>('/api/pre-access/logout', {
    method: 'POST',
    token: null,
  });
}
