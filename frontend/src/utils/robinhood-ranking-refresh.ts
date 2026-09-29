const SOURCES = ['positions', 'transfers', 'swaps', 'prices', 'reorg'] as const;
const MAX_VERSION = 9223372036854775807n;

export interface WalletRankingInvalidation {
  type: 'wallet-ranking:invalidate';
  chain: 'robinhood';
  version: 1;
  revisions: Partial<Record<(typeof SOURCES)[number], string>>;
  publishedAt: string;
}

export function normalizeWalletRankingInvalidation(payload: unknown): WalletRankingInvalidation | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as Record<string, unknown>;
  if (value.type !== 'wallet-ranking:invalidate' || value.chain !== 'robinhood'
    || value.version !== 1 || !Number.isFinite(Date.parse(String(value.publishedAt || '')))
    || !value.revisions || typeof value.revisions !== 'object'
    || Array.isArray(value.revisions)) return null;
  const entries = Object.entries(value.revisions);
  if (!entries.length || entries.some(([source, revision]) =>
    !SOURCES.includes(source as (typeof SOURCES)[number])
    || typeof revision !== 'string' || !/^[1-9]\d{0,18}$/.test(revision)
    || BigInt(revision) > MAX_VERSION)) return null;
  return value as unknown as WalletRankingInvalidation;
}

export function createWalletRankingRefreshGate(
  refresh: () => Promise<unknown> | void,
  options: {
    now?: () => number;
    setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
    minIntervalMs?: number;
  } = {},
) {
  const seen = new Map<string, bigint>();
  const now = options.now || Date.now;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const interval = options.minIntervalMs ?? 250;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let active = false;
  let lastStarted = -Infinity;

  function schedule() {
    if (!pending || active || timer !== null) return;
    const delay = Math.max(0, interval - (now() - lastStarted));
    timer = setTimer(() => {
      timer = null;
      if (!pending || active) return;
      pending = false;
      active = true;
      lastStarted = now();
      void Promise.resolve().then(refresh).finally(() => {
        active = false;
        schedule();
      });
    }, delay);
  }

  function request() {
    pending = true;
    schedule();
  }

  return {
    accept(event: WalletRankingInvalidation) {
      let changed = false;
      for (const [source, revision] of Object.entries(event.revisions)) {
        const version = BigInt(revision);
        if (version > (seen.get(source) || 0n)) {
          seen.set(source, version);
          changed = true;
        }
      }
      if (changed) request();
      return changed;
    },
    recover: request,
    clear() {
      pending = false;
      seen.clear();
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
