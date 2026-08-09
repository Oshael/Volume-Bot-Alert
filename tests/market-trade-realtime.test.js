const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CHANNEL, buildMarketTradeUpdate, createMarketTradeRealtime,
} = require('../src/services/market-trade-realtime');

function row(overrides = {}) {
  return {
    tokenAddress: `0x${'a'.repeat(40)}`, transactionHash: `0x${'1'.repeat(64)}`,
    actionIndex: '3', blockNumber: '100', blockTime: '2026-08-09T12:00:00Z',
    side: 'buy', walletAddress: `0x${'b'.repeat(40)}`,
    volumeUsd: '12.5', priceUsd: '0.5', fdvUsd: '48000', ...overrides,
  };
}

test('publishes every persisted trade in one pg_notify batch', async () => {
  const calls = [];
  const relay = createMarketTradeRealtime({ database: { query: async (...args) => calls.push(args) } });
  assert.equal(await relay.publishRows([row(), row({ actionIndex: '4' })]), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1][0], CHANNEL);
  assert.equal(calls[0][1][1].length, 2);
  assert.equal(JSON.parse(calls[0][1][1][0]).mcUsd, 48000);
});

test('propagates publish failures so the live worker can retry', async () => {
  const relay = createMarketTradeRealtime({
    database: { query: async () => { throw new Error('offline'); } },
    logger: { error: () => {} },
  });
  await assert.rejects(relay.publishRows([row()]), /offline/);
  assert.equal(relay.getStatus().publishFailures, 1);
});

test('relays only valid channel payloads to the socket hub', () => {
  const emitted = [];
  const relay = createMarketTradeRealtime({
    socketHub: { emitMarketTradeUpdate: (event) => emitted.push(event) },
  });
  const event = buildMarketTradeUpdate(row());
  assert.equal(relay.handleNotification({ channel: CHANNEL, payload: JSON.stringify(event) }).type, 'market:trade');
  assert.equal(relay.handleNotification({ channel: 'other', payload: JSON.stringify(event) }), null);
  assert.equal(emitted.length, 1);
});
