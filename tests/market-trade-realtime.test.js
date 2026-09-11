const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CHANNEL, FINALITY_CHANNEL, buildMarketTradeUpdate, createMarketTradeRealtime,
} = require('../src/services/market-trade-realtime');

function row(overrides = {}) {
  return {
    tokenAddress: `0x${'a'.repeat(40)}`, transactionHash: `0x${'1'.repeat(64)}`,
    actionIndex: '3', blockNumber: '100', blockHash: `0x${'f'.repeat(64)}`,
    blockTime: '2026-08-09T12:00:00Z',
    side: 'buy', walletAddress: `0x${'b'.repeat(40)}`,
    volumeUsd: '12.5', priceUsd: '0.5', fdvUsd: '48000', ...overrides,
  };
}

test('publishes every persisted trade in one pg_notify batch', async () => {
  const calls = [];
  const relay = createMarketTradeRealtime({
    database: { query: async (...args) => calls.push(args) },
    now: () => Date.parse('2026-08-09T12:00:00.500Z'),
  });
  assert.equal(await relay.publishRows([row({
    latency: { receiptsAvailableAt: '2026-08-09T12:00:00.100Z' },
  }), row({ actionIndex: '4' })]), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1][0], CHANNEL);
  assert.equal(calls[0][1][1].length, 2);
  const payload = JSON.parse(calls[0][1][1][0]);
  assert.equal(payload.mcUsd, 48000);
  assert.equal(payload.latency.projectionCommittedAt, '2026-08-09T12:00:00.500Z');
  assert.equal(payload.latency.receiptsAvailableAt, '2026-08-09T12:00:00.100Z');
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
  const finality = [];
  const relay = createMarketTradeRealtime({
    socketHub: {
      emitMarketTradeUpdate: (event) => emitted.push(event),
      emitMarketTradeFinalityUpdate: (event) => finality.push(event),
    },
    now: () => Date.parse('2026-08-09T12:00:00.700Z'),
  });
  const event = buildMarketTradeUpdate(row({
    latency: { receiptsAvailableAt: '2026-08-09T12:00:00.100Z' },
  }));
  assert.equal(relay.handleNotification({ channel: CHANNEL, payload: JSON.stringify(event) }).type, 'market:trade');
  assert.equal(relay.handleNotification({ channel: 'other', payload: JSON.stringify(event) }), null);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].latency.publishedAt, '2026-08-09T12:00:00.700Z');
  assert.equal(finality.length, 1);
  assert.equal(finality[0].type, 'market:trade:finalized');
  assert.equal(finality[0].finality, 'finalized');
  assert.equal(finality[0].asOfBlock, 100);
  assert.equal(finality[0].asOfBlockHash, `0x${'f'.repeat(64)}`);
  assert.equal(relay.getStatus().latency.stages.receiptToPublishedMs.p95Ms, 600);
});

test('transports lifecycle events only to the inert canary relay', async () => {
  const calls = [];
  const canary = [];
  const relay = createMarketTradeRealtime({
    database: { query: async (...args) => calls.push(args) },
    socketHub: { emitMarketTradeCanaryUpdate: (event) => canary.push(event) },
    now: () => Date.parse('2026-08-09T12:00:00.700Z'),
  });
  const payload = {
    ...row(), protocolVersion: 2, type: 'market:trade:observed', finality: 'observed',
    asOfBlock: '100', asOfBlockHash: `0x${'f'.repeat(64)}`,
    observedAt: '2026-08-09T12:00:00.100Z',
  };
  assert.equal(await relay.publishFinalityRows([payload]), true);
  assert.equal(calls[0][1][0], FINALITY_CHANNEL);
  const transported = JSON.parse(calls[0][1][1][0]);
  assert.equal(transported.address, payload.tokenAddress);
  assert.equal(transported.publishedAt, undefined);
  assert.equal(relay.handleFinalityNotification({
    channel: FINALITY_CHANNEL, payload: JSON.stringify(transported),
  }).type, 'market:trade:observed');
  assert.equal(canary.length, 1);
  assert.equal(canary[0].publishedAt, '2026-08-09T12:00:00.700Z');
});
