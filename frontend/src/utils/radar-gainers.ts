import type { RadarGainersPage } from '../services/api/robinhood-radar-gainers';
import { robinhoodIdentities } from './radar-unified.ts';

export interface GainersInput { token: string | null; available: boolean; dismissedIdentities: string[] }

export function gainersPercent(value: string | number | null) {
  if (value == null || value === '') return '-';
  const number = Number(value);
  return Number.isFinite(number) ? `${number >= 0 ? '+' : ''}${number.toFixed(2)}%` : '-';
}

function assertPage(page: RadarGainersPage) {
  if (page.chain !== 'robinhood' || !Number.isFinite(Date.parse(page.asOf))
    || !Array.isArray(page.items) || page.items.length > 20
    || page.items.some((row) => row.identity?.chain !== 'robinhood'
      || !/^0x[0-9a-f]{40}$/.test(row.identity.address)
      || row.identity.key !== `robinhood:${row.identity.address}`
      || row.priceBasis?.coverage !== 'available-history'
      || !Number.isFinite(Number(row.priceChangePct)) || Number(row.priceChangePct) <= 0)) {
    throw new Error('Invalid gainers response');
  }
}

export function createRadarGainersLoader(
  fetchPage: (input: GainersInput, signal: AbortSignal) => Promise<RadarGainersPage>,
  changed: () => void = () => {}, now: () => number = Date.now,
) {
  const state = { page: null as RadarGainersPage | null, loading: false, message: null as string | null };
  let key = '';
  let revision = 0;
  let blockedUntil = 0;
  let request: AbortController | null = null;
  return { state, async update(supplied: GainersInput, manual = false) {
    const input = { ...supplied, dismissedIdentities: robinhoodIdentities(supplied.dismissedIdentities).sort() };
    const nextKey = JSON.stringify([input.token, input.available, input.dismissedIdentities]);
    if (key !== nextKey) {
      key = nextKey; revision += 1; request?.abort();
      state.page = null; state.message = null; state.loading = false;
    }
    if (!input.available) {
      state.message = 'Robinhood gainers are unavailable.'; changed(); return;
    }
    if (state.loading || (!manual && (state.page || state.message))) return;
    if (input.dismissedIdentities.length > 5000) {
      state.message = 'Too many hidden tokens to load gainers.'; changed(); return;
    }
    if (now() < blockedUntil) {
      state.message = 'Please wait before refreshing gainers.'; changed(); return;
    }
    const current = ++revision;
    request = new AbortController();
    blockedUntil = now() + 5000;
    state.loading = true; state.page = null; state.message = null; changed();
    try {
      const page = await fetchPage(input, request.signal);
      if (current !== revision) return;
      assertPage(page);
      state.page = page;
    } catch (error) {
      if (current !== revision) return;
      const delay = Number((error as { retryAfterMs?: number })?.retryAfterMs);
      blockedUntil = Math.max(blockedUntil, now() + (Number.isFinite(delay) && delay > 0 ? Math.min(300000, delay) : 10000));
      state.message = 'Gainers are temporarily unavailable. Please refresh later.';
    } finally {
      if (current === revision) { state.loading = false; changed(); }
    }
  } };
}
