// Robinhood expanded-chart trades panel: fetch + render + light polling.
// Mounted only for the Robinhood chain from the expanded-sparkline modal; the
// hub (layout-sections.ts) only calls mount/destroy, keeping its footprint to
// wiring. All formatting lives in ./robinhood-trades-format (unit-tested).
import { fetchRobinhoodTokenTrades } from '../services/api/robinhood-trades';
import { tradesListHtml } from './robinhood-trades-format';

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
    + '</header>'
    + '<div class="robinhood-trades-cols">'
    + '<span>Amount</span><span>MC</span><span>Trader</span>'
    + '<span class="robinhood-trades-col-age">Age ↓</span>'
    + '</div>'
    + '<ul class="robinhood-trades-list" data-robinhood-trades-list>'
    + '<li class="robinhood-trades-empty">Loading…</li>'
    + '</ul>';
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

  const load = async () => {
    try {
      const page = await fetchRobinhoodTokenTrades(
        { token: options.token, limit: PANEL_LIMIT },
        options.authToken,
      );
      if (disposed) {
        return;
      }
      setList(panel, tradesListHtml(page.trades, Date.now()));
    } catch (_) {
      if (disposed) {
        return;
      }
      setList(panel, '<li class="robinhood-trades-empty">Failed to load trades</li>');
    }
  };

  void load();
  timer = window.setInterval(() => { void load(); }, REFRESH_INTERVAL_MS);

  activeCleanup = () => {
    disposed = true;
    if (timer != null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}
