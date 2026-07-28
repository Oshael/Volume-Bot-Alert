import type { AppState, MarketTickerEntry } from '../../state/app-state';
import { escapeHtml } from './html-safety';
import { getWorkspaceConnectionState, renderWorkspaceSocialLinks } from './layout-sections';

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'HYPE', 'PUMP'];

const ICONS: Record<string, string> = {
  BTC: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#f7931a"/><text x="12" y="16.2" text-anchor="middle" fill="#fff" font-size="13" font-weight="800">₿</text></svg>',
  ETH: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#8c8c8c" d="m12 1 6.7 11-6.7 3.8L5.3 12z"/><path fill="#343434" d="M12 1v14.8L18.7 12z"/><path fill="#8c8c8c" d="m12 17.1 6.7-3.8L12 23z"/><path fill="#3c3c3b" d="M5.3 13.3 12 23v-5.9z"/></svg>',
  SOL: '<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="ticker-sol" x1="2" y1="22" x2="22" y2="2"><stop stop-color="#00ffa3"/><stop offset="1" stop-color="#dc1fff"/></linearGradient></defs><path fill="url(#ticker-sol)" d="M5 3h15l-3 3H2zm2 7h15l-3 3H4zm-3 7h15l-3 3H1z"/></svg>',
  HYPE: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#07110f"/><path fill="#72f5c5" d="M4.2 12c2.2-5.7 5.1-7.2 7.1-3.4 1.2 2.2 2 3.1 3.2 2.1 1.4-1.2 2.8-1.2 5.3.6-2.2 5.7-5.1 7.2-7.1 3.4-1.2-2.2-2-3.1-3.2-2.1-1.4 1.2-2.8 1.2-5.3-.6Z"/></svg>',
  PUMP: '<img src="/launchpad-pump.png" alt="" aria-hidden="true" />',
};

function formatPrice(price: number) {
  const digits = price >= 1 ? 2 : price >= 0.01 ? 4 : 6;
  return `$${price.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function renderItem(item: MarketTickerEntry | undefined, symbol: string) {
  if (!item) {
    return `<div class="market-ticker-item" data-market-symbol="${symbol}" aria-label="${symbol} market loading">
      <span class="market-ticker-icon">${ICONS[symbol]}</span><span class="market-ticker-price">—</span>
    </div>`;
  }
  const direction = item.change24hPct > 0 ? 'up' : item.change24hPct < 0 ? 'down' : 'flat';
  const arrow = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '•';
  return `<div class="market-ticker-item" data-market-symbol="${escapeHtml(symbol)}" aria-label="${escapeHtml(symbol)} ${formatPrice(item.priceUsd)}">
    <span class="market-ticker-icon">${ICONS[symbol]}</span>
    <span class="market-ticker-price">${formatPrice(item.priceUsd)}</span>
    <span class="market-ticker-delta market-ticker-delta--${direction}">${arrow} ${Math.abs(item.change24hPct).toFixed(2)}%</span>
  </div>`;
}

export function renderMarketTickerSection(state: AppState) {
  const section = document.createElement('footer');
  const connectionState = getWorkspaceConnectionState(state);
  section.className = 'workspace-market-ticker';
  section.dataset.stale = String(state.data.marketTicker.stale);
  section.setAttribute('aria-label', 'Market prices');
  if (state.data.marketTicker.stale) section.title = 'Showing the latest available market update';
  const items = new Map(state.data.marketTicker.items.map((item) => [item.symbol, item]));
  section.innerHTML = `
    <div class="workspace-market-ticker-inner">${SYMBOLS.map((symbol) => renderItem(items.get(symbol), symbol)).join('')}</div>
    <div class="workspace-market-ticker-meta">
      <span class="workspace-connection-status workspace-footer-connection" data-footer-connection-status data-state="${connectionState.tone}" role="status" aria-label="Connection status: ${connectionState.label}" title="${connectionState.label}">
        <span class="workspace-connection-dot" aria-hidden="true"></span>
        <span class="workspace-connection-label">${connectionState.label}</span>
      </span>
      ${renderWorkspaceSocialLinks()}
    </div>
  `;
  return section;
}
