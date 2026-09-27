import type { AppController } from '../../state/app-controller';
import type { AppState } from '../../state/app-state';
import {
  fetchRobinhoodWalletTrades,
  type RobinhoodWalletTrade,
  type RobinhoodWalletTradesPage,
  type RobinhoodWalletTradeSide,
} from '../../services/api/robinhood-trades';
import { escapeHtml } from './html-safety';
import { formatUsd, shortenTrader } from '../robinhood-trades-format';

const SIDES: RobinhoodWalletTradeSide[] = ['all', 'buy', 'sell'];
const LIMIT = 30;
const HASH_RE = /^0x[0-9a-f]{64}$/i;

function tradeRowHtml(trade: RobinhoodWalletTrade) {
  const side = trade.side === 'sell' ? 'sell' : 'buy';
  const token = escapeHtml(trade.tokenAddress);
  const amount = trade.tokenAmount == null ? 'Quantity unavailable' : escapeHtml(trade.tokenAmount);
  const usd = trade.amountUsd == null ? 'Valuation unavailable' : formatUsd(trade.amountUsd);
  const timestamp = Date.parse(trade.blockTime);
  const time = Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : 'Time unavailable';
  const transaction = HASH_RE.test(trade.transactionHash)
    ? `<a href="https://robinhoodchain.blockscout.com/tx/${escapeHtml(trade.transactionHash)}" target="_blank" rel="noopener noreferrer">Transaction ↗</a>`
    : '<span>Transaction unavailable</span>';
  return `<tr class="radar-wallet-trade-${side}">
    <td>${side.toUpperCase()}</td>
    <td title="${token}">${escapeHtml(shortenTrader(trade.tokenAddress))}</td>
    <td>${amount}</td>
    <td>${escapeHtml(usd)}</td>
    <td>${escapeHtml(time)}</td>
    <td>${transaction}</td>
  </tr>`;
}

export function renderRadarWalletTradesSection(state: AppState, controller: AppController) {
  const wallet = state.ui.radarWalletAddress;
  if (!wallet) throw new Error('Radar wallet route is missing an address');
  const section = document.createElement('section');
  section.className = 'legacy-token-bar radar-wallet-trades';
  const visible = state.data.availableChains.includes('robinhood')
    && state.data.chainReadiness.robinhood?.capabilities.history === true;
  section.innerHTML = `
    <div class="legacy-bar-head radar-wallet-head">
      <button type="button" data-wallet-back>← Radar</button>
      <span class="legacy-bar-title">WALLET · ROBINHOOD</span>
      <code title="${wallet}">${escapeHtml(shortenTrader(wallet))}</code>
      <button type="button" data-wallet-copy>Copy address</button>
      <a href="https://robinhoodchain.blockscout.com/address/${wallet}" target="_blank" rel="noopener noreferrer">Explorer ↗</a>
    </div>
    <div class="radar-wallet-trades-content">
      <h2>Purchases and sales</h2>
      ${visible ? `<div class="radar-wallet-trade-filters" role="group" aria-label="Trade side">
        ${SIDES.map((side) => `<button type="button" data-wallet-side="${side}" aria-pressed="${side === 'all'}">${side.toUpperCase()}</button>`).join('')}
      </div>
      <p data-wallet-status role="status">Loading trades…</p>
      <div class="radar-wallet-trades-scroll"><table><thead><tr>
        <th>Side</th><th>Token</th><th>Quantity</th><th>USD</th><th>Time</th><th>Link</th>
      </tr></thead><tbody data-wallet-trades></tbody></table></div>
      <button type="button" data-wallet-more hidden>Load more</button>`
    : '<p role="status">Robinhood wallet history is unavailable.</p>'}
    </div>`;

  section.querySelector<HTMLButtonElement>('[data-wallet-back]')?.addEventListener('click', () => {
    controller.setWorkspace('history');
  });
  section.querySelector<HTMLButtonElement>('[data-wallet-copy]')?.addEventListener('click', () => {
    void navigator.clipboard.writeText(wallet);
  });
  if (!visible) return section;

  const status = section.querySelector<HTMLElement>('[data-wallet-status]');
  const body = section.querySelector<HTMLTableSectionElement>('[data-wallet-trades]');
  const more = section.querySelector<HTMLButtonElement>('[data-wallet-more]');
  let side: RobinhoodWalletTradeSide = 'all';
  let cursor: string | null = null;
  let loading = false;
  let requestId = 0;

  const setStatus = (message: string) => {
    if (status) status.textContent = message;
  };
  const setMore = (hidden: boolean, disabled = false) => {
    if (more) {
      more.hidden = hidden;
      more.disabled = disabled;
    }
  };
  const renderPage = (page: RobinhoodWalletTradesPage, append: boolean) => {
    const rows = page.trades.map(tradeRowHtml).join('');
    if (body) body.innerHTML = append ? body.innerHTML + rows : rows;
    cursor = page.nextCursor;
    setMore(!page.hasMore);
    setStatus(body?.children.length ? '' : 'No trades found for this wallet.');
  };

  const load = async (append = false) => {
    if (loading) return;
    loading = true;
    const currentRequest = ++requestId;
    const requestedSide = side;
    setStatus('Loading trades…');
    setMore(more?.hidden ?? true, true);
    try {
      const page = await fetchRobinhoodWalletTrades({
        wallet, side: requestedSide, cursor: append ? cursor : null, limit: LIMIT,
      }, state.session.token);
      if (!section.isConnected || currentRequest !== requestId) return;
      renderPage(page, append);
    } catch (_) {
      if (!section.isConnected || currentRequest !== requestId) return;
      setStatus('Could not load wallet trades. Try again.');
      setMore(false);
    } finally {
      if (currentRequest === requestId) {
        loading = false;
        setMore(more?.hidden ?? true);
      }
    }
  };

  section.querySelectorAll<HTMLButtonElement>('[data-wallet-side]').forEach((button) => {
    button.addEventListener('click', () => {
      const nextSide = button.dataset.walletSide as RobinhoodWalletTradeSide;
      if (!SIDES.includes(nextSide) || side === nextSide) return;
      side = nextSide;
      cursor = null;
      requestId += 1;
      loading = false;
      if (body) body.innerHTML = '';
      setMore(true);
      section.querySelectorAll<HTMLButtonElement>('[data-wallet-side]').forEach((item) => {
        item.setAttribute('aria-pressed', String(item.dataset.walletSide === side));
      });
      void load();
    });
  });
  more?.addEventListener('click', () => { void load(true); });
  void load();
  return section;
}
