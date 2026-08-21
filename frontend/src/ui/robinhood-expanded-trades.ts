// Robinhood expanded-chart trades panel: fetch + render + light polling.
// Mounted only for the Robinhood chain from the expanded-sparkline modal; the
// hub (layout-sections.ts) only calls mount/destroy, keeping its footprint to
// wiring. All formatting lives in ./robinhood-trades-format (unit-tested).
import { fetchRobinhoodTokenTrades } from '../services/api/robinhood-trades';
import { subscribeRobinhoodTrades } from '../services/socket/client';
import { mergeLiveTrade, tradeMatchesWalletScope, tradesListHtml } from './robinhood-trades-format';
import type { RobinhoodTrade, RobinhoodTradeScope } from '../services/api/robinhood-trades';

const REFRESH_INTERVAL_MS = 5000;
const PANEL_LIMIT = 30;

interface MountOptions {
  token: string;
  authToken?: string | null;
}

let activeCleanup: (() => void) | null = null;

function panelSkeleton(): string {
  return '<header class="robinhood-trades-head">'
    + '<span class="robinhood-trades-title">Trades</span>'
    + '<span class="robinhood-trades-status" data-robinhood-trades-status></span>'
    + '<div class="robinhood-trades-scopes" role="tablist" aria-label="Trade wallet scope">'
    + '<button type="button" class="active" role="tab" aria-selected="true" data-trade-scope="all">All</button>'
    + '<button type="button" role="tab" aria-selected="false" data-trade-scope="dev">Dev</button>'
    + '</div>'
    + '</header>'
    + '<div class="robinhood-trades-cols">'
    + '<span>Amount</span><span>MC</span><span>Trader</span>'
    + '<span class="robinhood-trades-col-age">Age ↓</span>'
    + '</div>'
    + '<ul class="robinhood-trades-list" data-robinhood-trades-list>'
    + '<li class="robinhood-trades-empty">Loading…</li>'
    + '</ul>';
}

function setStatus(panel: HTMLElement, value: string) {
  const status = panel.querySelector<HTMLElement>('[data-robinhood-trades-status]');
  if (status) status.textContent = value;
}

function setActiveScope(panel: HTMLElement, scope: RobinhoodTradeScope) {
  panel.querySelectorAll<HTMLButtonElement>('[data-trade-scope]').forEach((button) => {
    const active = button.dataset.tradeScope === scope;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
}

function setList(panel: HTMLElement, html: string) {
  const list = panel.querySelector<HTMLElement>('[data-robinhood-trades-list]');
  if (list) {
    list.innerHTML = html;
  }
}

export function destroyRobinhoodExpandedTrades() {
  activeCleanup?.();
  activeCleanup = null;
}

export function mountRobinhoodExpandedTrades(section: ParentNode, options: MountOptions) {
  destroyRobinhoodExpandedTrades();
  const panel = section.querySelector<HTMLElement>('[data-robinhood-trades-panel]');
  if (!panel) {
    return;
  }
  panel.innerHTML = panelSkeleton();

  let disposed = false;
  let timer: number | null = null;
  let trades: RobinhoodTrade[] = [];
  let scope: RobinhoodTradeScope = 'all';
  let creatorAddress: string | null = null;
  let requestId = 0;

  const render = () => setList(panel, tradesListHtml(trades, Date.now()));
  const unsubscribe = subscribeRobinhoodTrades(options.token, (event) => {
    if (disposed) return;
    if (!tradeMatchesWalletScope(event, scope, creatorAddress)) return;
    trades = mergeLiveTrade(trades, event, PANEL_LIMIT);
    render();
  });

  const load = async () => {
    const currentRequestId = ++requestId;
    const requestedScope = scope;
    try {
      const page = await fetchRobinhoodTokenTrades(
        { token: options.token, scope: requestedScope, limit: PANEL_LIMIT },
        options.authToken,
      );
      if (disposed || currentRequestId !== requestId) {
        return;
      }
      creatorAddress = page.creatorAddress?.toLowerCase() || null;
      trades = page.trades;
      setStatus(panel, requestedScope === 'dev' && !creatorAddress ? 'Creator unavailable' : '');
      render();
    } catch (_) {
      if (disposed || currentRequestId !== requestId) {
        return;
      }
      setList(panel, '<li class="robinhood-trades-empty">Failed to load trades</li>');
    }
  };

  const onScopeClick = (event: Event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-trade-scope]');
    const nextScope = button?.dataset.tradeScope as RobinhoodTradeScope | undefined;
    if (!nextScope || nextScope === scope) return;
    scope = nextScope;
    creatorAddress = null;
    trades = [];
    setActiveScope(panel, scope);
    setStatus(panel, '');
    setList(panel, '<li class="robinhood-trades-empty">Loading…</li>');
    void load();
  };

  panel.addEventListener('click', onScopeClick);
  void load();
  timer = window.setInterval(() => { void load(); }, REFRESH_INTERVAL_MS);

  activeCleanup = () => {
    disposed = true;
    requestId += 1;
    panel.removeEventListener('click', onScopeClick);
    unsubscribe?.();
    if (timer != null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}
