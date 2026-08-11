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
      logger: { error() {} },
    });

    await assert.rejects(realtime.publishUpdates([update()]), /database offline/);
    assert.equal(realtime.getStatus().publishFailures, 1);
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
    });

    await realtime.start({ pool: { connect: async () => client } });
    client.emit('notification', { channel: CHANNEL, payload: JSON.stringify(update()) });
    client.emit('notification', {
      channel: CHANNEL, payload: JSON.stringify(update({ invalidated: true })),
    });
    client.emit('notification', { channel: CHANNEL, payload: '{}' });

    assert.match(queries[0], new RegExp(`LISTEN ${CHANNEL}`));
    assert.equal(emitted.length, 2);
    assert.equal(emitted[0].type, 'holder:count');
    assert.equal(emitted[1].type, 'holder:invalidate');
    await realtime.stop();
  });
});
