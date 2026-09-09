const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { EventEmitter } = require('node:events');

const {
  normalizeRobinhoodHolderCountEvent,
  normalizeRobinhoodHolderRealtimeEvent,
} = require('../src/services/robinhood-holder-count-event');
const {
  CHANNEL,
  createRobinhoodHolderCountRealtime,
} = require('../src/services/robinhood-holder-count-realtime');
const { normalizeHolderTransfer } = require('../src/models/robinhood-holder-ledger');

const TOKEN = `0x${'a'.repeat(40)}`;
const HASH = `0x${'b'.repeat(64)}`;

function update(overrides = {}) {
  return {
    tokenAddress: TOKEN, holderCount: '4424', ledgerVersion: '7',
    observedAt: '2026-08-10T12:00:00.000Z', liveThroughBlock: '32653260',
    liveThroughHash: HASH, ...overrides,
  };
}

describe('Robinhood holder count realtime', () => {
  it('retains available canonical source latency on holder transfers', () => {
    const transfer = normalizeHolderTransfer({
      blockNumber: '1', blockHash: HASH, transactionHash: HASH,
      transactionIndex: 0, logIndex: 0, tokenAddress: TOKEN,
      fromWallet: TOKEN, toWallet: TOKEN, amountRaw: '1',
      latency: { receiptsAvailableAt: '2026-08-10T12:00:00.100Z', captureCommittedAt: null },
    });
    assert.deepEqual(transfer.latency, {
      receiptsAvailableAt: '2026-08-10T12:00:00.100Z',
    });
  });

  it('normalizes a compact sequenced public event and rejects unsafe counts', () => {
    assert.deepEqual(normalizeRobinhoodHolderCountEvent(update({
      tokenAddress: TOKEN.toUpperCase(),
    })), {
      type: 'holder:count', chain: 'robinhood', address: TOKEN,
      holderCount: 4424, source: 'ledger_live', observedAt: '2026-08-10T12:00:00.000Z',
      ledgerVersion: '7', liveThroughBlock: '32653260', liveThroughHash: HASH,
      sequence: `robinhood-holder:${TOKEN}:000000000000000000000007`,
    });
    assert.equal(normalizeRobinhoodHolderCountEvent(update({
      holderCount: '9007199254740992',
    })), null);
    assert.equal(normalizeRobinhoodHolderCountEvent(update({
      latency: { publishedAt: 'invalid' },
    })).holderCount, 4424);
    assert.deepEqual(normalizeRobinhoodHolderRealtimeEvent(update({
      invalidated: true, holderCount: undefined, ledgerVersion: '8',
    })), {
      type: 'holder:invalidate', chain: 'robinhood', address: TOKEN,
      source: 'ledger_live', observedAt: '2026-08-10T12:00:00.000Z',
      ledgerVersion: '8', liveThroughBlock: '32653260', liveThroughHash: HASH,
      sequence: `robinhood-holder:${TOKEN}:000000000000000000000008`,
      reason: 'reorg_resync',
    });
  });

  it('coalesces each token and publishes bounded PostgreSQL notifications', async () => {
    const calls = [];
    const realtime = createRobinhoodHolderCountRealtime({
      database: { query: async (...args) => calls.push(args) },
      persistLiveCounts: async (events) => assert.equal(events.length, 1),
    });

    assert.equal(await realtime.publishUpdates([
      update({ holderCount: '4400', ledgerVersion: '6' }),
      update(),
      { tokenAddress: 'bad' },
    ]), 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1][0], CHANNEL);
    const published = JSON.parse(calls[0][1][1][0]);
    assert.equal(published.holderCount, 4424);
    assert.equal(published.ledgerVersion, '7');
  });

  it('propagates PostgreSQL publication failure for worker retry', async () => {
    const realtime = createRobinhoodHolderCountRealtime({
      database: { query: async () => { throw new Error('database offline'); } },
      persistLiveCounts: async () => {},
      logger: { error() {} },
    });

    await assert.rejects(realtime.publishUpdates([update()]), /database offline/);
    assert.equal(realtime.getStatus().publishFailures, 1);
  });

  it('persists count events in bounded batches without treating invalidations as counts', async () => {
    const persisted = [];
    const notifications = [];
    const realtime = createRobinhoodHolderCountRealtime({
      database: { query: async (...args) => notifications.push(args) },
      persistLiveCounts: async (events) => persisted.push(events),
    });
    const counts = Array.from({ length: 501 }, (_, index) => update({
      tokenAddress: `0x${index.toString(16).padStart(40, '0')}`,
      holderCount: String(index), ledgerVersion: String(index + 1),
    }));
    const invalidation = update({
      tokenAddress: `0x${'f'.repeat(40)}`, invalidated: true,
      holderCount: undefined, ledgerVersion: '999',
    });

    assert.equal(await realtime.publishUpdates([...counts, invalidation]), 502);
    assert.deepEqual(persisted.map((events) => events.length), [500, 1]);
    assert.equal(persisted.flat().every((event) => event.type === 'holder:count'), true);
    assert.deepEqual(notifications.map((call) => call[1][1].length), [500, 2]);
  });

  it('forwards valid LISTEN notifications to the local socket hub', async () => {
    const client = new EventEmitter();
    const queries = [];
    const emitted = [];
    client.query = async (sql) => queries.push(sql);
    client.release = () => {};
    const realtime = createRobinhoodHolderCountRealtime({
      socketHub: { emitHolderUpdate: (event) => emitted.push(event) },
      logger: { error() {}, log() {} },
      now: () => Date.parse('2026-08-10T12:00:00.500Z'),
    });

    await realtime.start({ pool: { connect: async () => client } });
    client.emit('notification', { channel: CHANNEL, payload: JSON.stringify(update({
      latency: {
        receiptsAvailableAt: '2026-08-10T12:00:00.100Z',
        projectionCommittedAt: '2026-08-10T12:00:00.300Z',
      },
    })) });
    client.emit('notification', {
      channel: CHANNEL, payload: JSON.stringify(update({ invalidated: true })),
    });
    client.emit('notification', { channel: CHANNEL, payload: '{}' });

    assert.match(queries[0], new RegExp(`LISTEN ${CHANNEL}`));
    assert.equal(emitted.length, 2);
    assert.equal(emitted[0].type, 'holder:count');
    assert.equal(emitted[0].latency.publishedAt, '2026-08-10T12:00:00.500Z');
    assert.equal(emitted[1].type, 'holder:invalidate');
    assert.equal(realtime.getStatus().latency.stages.receiptToPublishedMs.p95Ms, 400);
    await realtime.stop();
  });
});
