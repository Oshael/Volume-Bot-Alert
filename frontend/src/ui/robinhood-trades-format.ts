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

// Trim a fixed-precision string to its shortest exact form ("2.50" -> "2.5").
function trimNumber(text: string): string {
  return String(Number(text));
}

// Axiom-style USD: significant-figure precision (not fixed decimals), K/M/B
// compaction above 1,000. Used for both the swap amount and the market cap, so
// small trades read "$7.59" and caps read "$13.6M".
export function formatUsd(value: number | null): string {
  if (value == null || !Number.isFinite(value)) {
    return '—';
  }
  if (value === 0) return '$0';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${trimNumber((value / 1e9).toPrecision(3))}B`;
  if (abs >= 1e6) return `$${trimNumber((value / 1e6).toPrecision(3))}M`;
  if (abs >= 1e3) return `$${trimNumber((value / 1e3).toPrecision(3))}K`;
  return `$${trimNumber(value.toPrecision(4))}`;
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

// Columns match Axiom: Amount | MC | Trader | Age. Side is encoded by the amount
// color (green buy / red sell) via the row class — no separate BUY/SELL cell.
export function tradeRowHtml(trade: TradeView, nowMs: number): string {
  const sideClass = trade.side === 'sell' ? 'is-sell' : 'is-buy';
  return `<li class="robinhood-trade-row ${sideClass}">`
    + `<span class="robinhood-trade-amount">${escapeHtml(formatUsd(trade.amountUsd))}</span>`
    + `<span class="robinhood-trade-mc">${escapeHtml(formatUsd(trade.mcUsd))}</span>`
    + `<span class="robinhood-trade-trader">${escapeHtml(shortenTrader(trade.walletAddress))}</span>`
    + `<span class="robinhood-trade-age">${escapeHtml(formatTradeAge(trade.blockTime, nowMs))}</span>`
    + '</li>';
}

export function tradesListHtml(trades: TradeView[], nowMs: number): string {
  if (!trades.length) {
    return '<li class="robinhood-trades-empty">No trades yet</li>';
  }
  return trades.map((trade) => tradeRowHtml(trade, nowMs)).join('');
}
