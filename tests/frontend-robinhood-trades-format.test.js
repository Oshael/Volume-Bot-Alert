const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  formatUsd,
  shortenTrader,
  formatTradeAge,
  mergeLiveTrade,
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
  it('formats USD with significant figures and K/M/B compaction', () => {
    assert.equal(formatUsd(1_500_000_000), '$1.5B');
    assert.equal(formatUsd(13_600_000), '$13.6M');
    assert.equal(formatUsd(2_060), '$2.06K');
    assert.equal(formatUsd(611.8), '$611.8');
    assert.equal(formatUsd(7.59), '$7.59');
    assert.equal(formatUsd(0.06), '$0.06');
    assert.equal(formatUsd(0), '$0');
    assert.equal(formatUsd(null), '—');
    assert.equal(formatUsd(Number.NaN), '—');
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

  it('encodes side via the row class (no BUY/SELL cell) and escapes values', () => {
    const buy = tradeRowHtml(trade(), NOW);
    assert.match(buy, /robinhood-trade-row is-buy/);
    assert.doesNotMatch(buy, />BUY</); // side is color-only now
    // columns are Amount | MC | Trader | Age in that order
    assert.match(buy, /trade-amount">\$2\.5K<.*trade-mc">\$988K<.*trade-trader">0x/);

    const sell = tradeRowHtml(trade({ side: 'sell', amountUsd: null }), NOW);
    assert.match(sell, /robinhood-trade-row is-sell/);
    // null amount surfaces the em-dash, not a crash
    assert.match(sell, /robinhood-trade-amount">—</);
  });

  it('shows an empty state instead of rows when there are no trades', () => {
    assert.match(tradesListHtml([], NOW), /robinhood-trades-empty/);
    const list = tradesListHtml([trade(), trade({ side: 'sell' })], NOW);
    assert.equal((list.match(/robinhood-trade-row/g) || []).length, 2);
  });

  it('prepends, orders, deduplicates and caps live trades', () => {
    const old = trade({ blockTime: '2026-08-06T23:58:00.000Z', actionIndex: 1 });
    const current = trade({ transactionHash: `0x${'b'.repeat(64)}`, actionIndex: 2 });
    const duplicate = trade({ ...current, amountUsd: 99 });
    assert.deepEqual(mergeLiveTrade([old, current], duplicate, 2), [duplicate, old]);
  });
});
