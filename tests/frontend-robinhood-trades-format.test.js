const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  formatUsdCompact,
  shortenTrader,
  formatTradeAge,
  tradeRowHtml,
  tradesListHtml,
} = require('../frontend/src/ui/robinhood-trades-format.ts');

const NOW = Date.parse('2026-08-07T00:00:00.000Z');

function trade(overrides = {}) {
  return {
    side: 'buy',
    walletAddress: '0x1111111111111111111111111111111111111111',
    amountUsd: 2500,
    mcUsd: 987654,
    blockTime: '2026-08-06T23:59:30.000Z',
    transactionHash: `0x${'a'.repeat(64)}`,
    actionIndex: 3,
    ...overrides,
  };
}

describe('robinhood trades format', () => {
  it('formats compact USD across magnitudes and null', () => {
    assert.equal(formatUsdCompact(1_500_000_000), '$1.50B');
    assert.equal(formatUsdCompact(987_654), '$987.65K');
    assert.equal(formatUsdCompact(2_500), '$2.50K');
    assert.equal(formatUsdCompact(42), '$42');
    assert.equal(formatUsdCompact(0.25), '$0.25');
    assert.equal(formatUsdCompact(null), '—');
    assert.equal(formatUsdCompact(Number.NaN), '—');
  });

  it('shortens only long trader addresses', () => {
    assert.equal(shortenTrader('0x1234567890abcdef1234'), '0x1234…1234');
    assert.equal(shortenTrader('0xabc'), '0xabc');
  });

  it('renders age in the largest fitting unit and clamps the future to 0s', () => {
    assert.equal(formatTradeAge('2026-08-06T23:59:30.000Z', NOW), '30s');
    assert.equal(formatTradeAge('2026-08-06T23:45:00.000Z', NOW), '15m');
    assert.equal(formatTradeAge('2026-08-06T20:00:00.000Z', NOW), '4h');
    assert.equal(formatTradeAge('2026-08-04T00:00:00.000Z', NOW), '3d');
    assert.equal(formatTradeAge('2026-08-07T00:00:05.000Z', NOW), '0s'); // clock skew
    assert.equal(formatTradeAge('not-a-date', NOW), '—');
  });

  it('marks buy vs sell and escapes rendered values', () => {
    const buy = tradeRowHtml(trade(), NOW);
    assert.match(buy, /robinhood-trade-row is-buy/);
    assert.match(buy, />BUY</);
    assert.match(buy, /\$2\.50K/);

    const sell = tradeRowHtml(trade({ side: 'sell', amountUsd: null }), NOW);
    assert.match(sell, /robinhood-trade-row is-sell/);
    assert.match(sell, />SELL</);
    // null amount surfaces the em-dash, not a crash
    assert.match(sell, /robinhood-trade-amount">—</);
  });

  it('shows an empty state instead of rows when there are no trades', () => {
    assert.match(tradesListHtml([], NOW), /robinhood-trades-empty/);
    const list = tradesListHtml([trade(), trade({ side: 'sell' })], NOW);
    assert.equal((list.match(/robinhood-trade-row/g) || []).length, 2);
  });
});
