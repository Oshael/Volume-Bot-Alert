const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildMarketTradeFinalityEvent,
  normalizeMarketTradeFinalityEvent,
} = require('../src/services/market-trade-finality-event');

function trade(overrides = {}) {
  return {
    type: 'market:trade', chain: 'robinhood', address: `0x${'a'.repeat(40)}`,
    transactionHash: `0x${'1'.repeat(64)}`, actionIndex: 3,
    blockNumber: 100, blockHash: `0x${'f'.repeat(64)}`,
    blockTime: '2026-09-10T12:00:00.000Z', side: 'buy',
    walletAddress: `0x${'b'.repeat(40)}`, amountUsd: 12, priceUsd: 0.5, mcUsd: 48_000,
    observedAt: '2026-09-10T12:00:00.100Z', publishedAt: '2026-09-10T12:00:00.200Z',
    ...overrides,
  };
}

test('builds an explicit versioned finality update from a complete trade', () => {
  const event = buildMarketTradeFinalityEvent(trade(), 'finalized');
  assert.equal(event.protocolVersion, 2);
  assert.equal(event.type, 'market:trade:finalized');
  assert.equal(event.finality, 'finalized');
  assert.equal(event.asOfBlock, 100);
  assert.equal(event.asOfBlockHash, `0x${'f'.repeat(64)}`);
});

test('accepts only reorg invalidations with a complete canonical identity', () => {
  const event = normalizeMarketTradeFinalityEvent({
    ...trade(), protocolVersion: 2, type: 'market:trade:invalidate', reason: 'reorg',
    asOfBlock: 100, asOfBlockHash: `0x${'f'.repeat(64)}`,
  });
  assert.equal(event.reason, 'reorg');
  assert.equal(normalizeMarketTradeFinalityEvent({ ...event, reason: 'unknown' }), null);
  assert.equal(normalizeMarketTradeFinalityEvent({ ...event, protocolVersion: 1 }), null);
  assert.equal(buildMarketTradeFinalityEvent(trade({ blockHash: null }), 'observed'), null);
});
