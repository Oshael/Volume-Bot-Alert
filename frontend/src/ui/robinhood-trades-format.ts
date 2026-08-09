// Pure presentation helpers for the Robinhood expanded-chart trades panel.
// Deliberately dependency-free so it can be unit-tested via node --test type
// stripping (see tests/frontend-robinhood-trades-format.test.js). No DOM, no
// network — only formatting rules and row markup.

export interface TradeView {
  side: 'buy' | 'sell';
  walletAddress: string;
  amountUsd: number | null;
  mcUsd: number | null;
  blockTime: string;
  transactionHash: string;
  actionIndex: number;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    if (ch === '&') return '&amp;';
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    if (ch === '"') return '&quot;';
    return '&#39;';
  });
}

// Compact USD used for both the swap amount and the market cap.
export function formatUsdCompact(value: number | null): string {
  if (value == null || !Number.isFinite(value)) {
    return '—';
  }
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(2)}K`;
  if (abs >= 1) return `$${value.toFixed(0)}`;
  return `$${value.toFixed(2)}`;
}

export function shortenTrader(address: string): string {
  const value = String(address || '');
  if (value.length <= 12) {
    return value;
  }
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

// Relative age from the swap's block_time; clamps a future/skewed timestamp to 0s.
export function formatTradeAge(blockTime: string, nowMs: number): string {
  const ts = Date.parse(blockTime);
  if (!Number.isFinite(ts)) {
    return '—';
  }
  const seconds = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function tradeRowHtml(trade: TradeView, nowMs: number): string {
  const sideClass = trade.side === 'sell' ? 'is-sell' : 'is-buy';
  const sideLabel = trade.side === 'sell' ? 'SELL' : 'BUY';
  return `<li class="robinhood-trade-row ${sideClass}">`
    + `<span class="robinhood-trade-side">${sideLabel}</span>`
    + `<span class="robinhood-trade-amount">${escapeHtml(formatUsdCompact(trade.amountUsd))}</span>`
    + `<span class="robinhood-trade-trader">${escapeHtml(shortenTrader(trade.walletAddress))}</span>`
    + `<span class="robinhood-trade-mc">${escapeHtml(formatUsdCompact(trade.mcUsd))}</span>`
    + `<span class="robinhood-trade-age">${escapeHtml(formatTradeAge(trade.blockTime, nowMs))}</span>`
    + '</li>';
}

export function tradesListHtml(trades: TradeView[], nowMs: number): string {
  if (!trades.length) {
    return '<li class="robinhood-trades-empty">No trades yet</li>';
  }
  return trades.map((trade) => tradeRowHtml(trade, nowMs)).join('');
}
