import { apiFetch } from './base';
import type { BillingOrderEntry, BillingPlanEntry } from '../../state/app-state';

export interface BillingStatePayload {
  enabled: boolean;
  provider: string;
  providerReady: boolean;
  providerMocked: boolean;
  plans: BillingPlanEntry[];
  orders: BillingOrderEntry[];
}

export interface CreateBillingOrderResponse {
  message: string;
  order: BillingOrderEntry;
  checkoutUrl: string | null;
}

export function fetchBillingState(token?: string | null) {
  return apiFetch<BillingStatePayload>('/api/billing/state', { token });
}

export function createBillingOrder(planKey: string, token?: string | null) {
  return apiFetch<CreateBillingOrderResponse>('/api/billing/orders', {
    method: 'POST',
    body: JSON.stringify({ planKey }),
    token,
  });
}
