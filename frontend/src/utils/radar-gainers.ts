import type { RadarGainersPage } from '../services/api/robinhood-radar-gainers';
import { robinhoodIdentities } from './radar-unified.ts';
import { normalizeWalletRankingInvalidation } from './robinhood-ranking-refresh.ts';

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
  live?: {
    visible: () => boolean;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
  },
) {
  const state = { page: null as RadarGainersPage | null, loading: false, message: null as string | null,
    connected: false, stale: true };
  let key = '';
  let revision = 0;
  let blockedUntil = 0;
  let request: AbortController | null = null;
  let context: GainersInput | null = null;
  const seen = new Map<string, bigint>();
  const setTimer = live?.setTimer || setTimeout;
  const clearTimer = live?.clearTimer || clearTimeout;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let freshnessTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingAt: number | null = null;
  let retryBudget = 0;

  function cancelTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function invalidatePage() {
    revision += 1; request?.abort();
    state.page = null; state.message = null; state.loading = false; state.stale = true;
    if (freshnessTimer !== null) clearTimer(freshnessTimer);
    freshnessTimer = null;
  }

  function schedule() {
    if (pendingAt === null || timer !== null || state.loading || !context?.available || !live?.visible()) return;
    timer = setTimer(() => {
      timer = null;
      if (!context?.available || !live?.visible()) return;
      const currentKey = key;
      const canRetry = retryBudget > 0;
      retryBudget = 0;
      void update(context, true).then((success) => {
        if (success === false && currentKey === key && canRetry && pendingAt === null) {
          pendingAt = blockedUntil; schedule();
        }
      });
    }, Math.max(0, pendingAt - now(), blockedUntil - now()));
  }

  function queue(urgent: boolean) {
    const due = now();
    const previous = pendingAt;
    const wasStale = state.stale;
    pendingAt = Math.min(pendingAt ?? Infinity, due);
    retryBudget = 1; state.stale = true;
    if (previous !== pendingAt) cancelTimer();
    schedule();
    if (urgent || !wasStale) changed();
  }

  function applyPage(page: RadarGainersPage) {
    state.page = page; state.stale = pendingAt !== null;
    if (!live) return;
    if (freshnessTimer !== null) clearTimer(freshnessTimer);
    // This deadline only marks the snapshot old; it never requests data.
    freshnessTimer = setTimer(() => { state.stale = true; changed(); },
      Math.max(1, Date.parse(page.asOf) + 120000 - now()));
  }

  function fail(error: unknown) {
    const delay = Number((error as { retryAfterMs?: number })?.retryAfterMs);
    blockedUntil = Math.max(blockedUntil, now() + (Number.isFinite(delay) && delay > 0 ? Math.min(300000, delay) : 10000));
    state.message = 'Gainers are temporarily unavailable. Please refresh later.';
  }

  async function update(supplied: GainersInput, manual = false): Promise<boolean | undefined> {
    const input = { ...supplied, dismissedIdentities: robinhoodIdentities(supplied.dismissedIdentities).sort() };
    const nextKey = JSON.stringify([input.token, input.available, input.dismissedIdentities]);
    if (key !== nextKey) {
      key = nextKey; invalidatePage(); cancelTimer(); pendingAt = null;
    }
    context = input;
    if (!input.available) {
      state.message = 'Robinhood gainers are unavailable.'; changed(); return;
    }
    if (state.loading || (!manual && (state.page || state.message))) return;
    if (input.dismissedIdentities.length > 5000) {
      state.message = 'Too many hidden tokens to load gainers.'; changed(); return;
    }
    if (now() < blockedUntil) {
      state.message = 'Please wait before refreshing gainers.';
      if (live) queue(true); else changed();
      return;
    }
    cancelTimer(); pendingAt = null;
    const current = ++revision;
    request = new AbortController();
    blockedUntil = now() + 500;
    state.loading = true; state.message = null; state.stale = true; changed();
    try {
      const page = await fetchPage(input, request.signal);
      if (current !== revision) return;
      assertPage(page);
      applyPage(page);
      return true;
    } catch (error) {
      if (current !== revision) return;
      fail(error);
      return false;
    } finally {
      if (current === revision) { state.loading = false; changed(); schedule(); }
    }
  }

  return { state, update,
    invalidate(payload: unknown) {
      const event = normalizeWalletRankingInvalidation(payload);
      if (!event) return false;
      let priceChanged = false;
      let reorgChanged = false;
      for (const source of ['prices', 'reorg'] as const) {
        const version = BigInt(event.revisions[source] || '0');
        if (version <= (seen.get(source) || 0n)) continue;
        seen.set(source, version);
        if (source === 'reorg') reorgChanged = true; else priceChanged = true;
      }
      if (!priceChanged && !reorgChanged) return false;
      if (reorgChanged) invalidatePage();
      queue(reorgChanged); return true;
    },
    recover() { invalidatePage(); queue(true); },
    connection(connected: boolean) { state.connected = connected; changed(); },
    resume(returning = true) {
      if (!live?.visible()) { cancelTimer(); return; }
      if (returning && state.page && now() - Date.parse(state.page.asOf) >= 60000 && pendingAt === null) queue(true);
      else schedule();
    },
  };
}
