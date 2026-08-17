const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');
const esbuild = require('../frontend/node_modules/esbuild');

const TOKEN = `0x${'a'.repeat(40)}`;
const HASH = `0x${'b'.repeat(64)}`;
let holderEvents;

before(async () => {
  const result = await esbuild.build({
    entryPoints: ['frontend/src/services/socket/holder-events.ts'],
    bundle: true, format: 'esm', platform: 'node', write: false,
  });
  const source = Buffer.from(result.outputFiles[0].text).toString('base64');
  holderEvents = await import(`data:text/javascript;base64,${source}`);
});

function realtime(overrides = {}) {
  const ledgerVersion = String(overrides.ledgerVersion || '7');
  return {
    type: 'holder:count', chain: 'robinhood', address: TOKEN,
    holderCount: 105, source: 'ledger_live', observedAt: '2026-08-10T12:30:00.000Z',
    ledgerVersion, liveThroughBlock: '32653260', liveThroughHash: HASH,
    sequence: `robinhood-holder:${TOKEN}:${ledgerVersion.padStart(24, '0')}`,
    ...overrides,
  };
}

function bar(start, end, delta) {
  return {
    start, end, holderCount: 100, observedAt: '2026-08-10T12:20:00.000Z',
    delta, status: 'open', comparison: 'complete',
  };
}

function history() {
  const delta = (value) => ({
    delta: value, comparison: 'complete',
    from: '2026-08-10T08:00:00.000Z', through: '2026-08-10T12:20:00.000Z',
  });
  return {
    token: TOKEN, asOf: '2026-08-10T12:25:00.000Z', resolution: '1h',
    intervals: ['1h', '4h', '12h', '24h'],
    range: { start: '2026-08-01T00:00:00.000Z', through: '2026-08-10T12:25:00.000Z', bucketCount: 100 },
    current: { holderCount: 100, source: 'ledger_live', observedAt: '2026-08-10T12:20:00.000Z' },
    deltas: { '4h': delta(5), '12h': delta(10), '1d': delta(20), '3d': delta(30), '7d': delta(40) },
    series: {
      '1h': [bar('2026-08-10T12:00:00.000Z', '2026-08-10T13:00:00.000Z', 2)],
      '4h': [bar('2026-08-10T12:00:00.000Z', '2026-08-10T16:00:00.000Z', 5)],
      '12h': [bar('2026-08-10T12:00:00.000Z', '2026-08-11T00:00:00.000Z', 10)],
      '24h': [bar('2026-08-10T00:00:00.000Z', '2026-08-11T00:00:00.000Z', 20)],
    },
  };
}

describe('frontend Robinhood holder realtime events', () => {
  it('normalizes the backend contract and rejects malformed or unsafe events', () => {
    const normalized = holderEvents.normalizeRobinhoodHolderEvent(realtime({
      address: TOKEN.toUpperCase(),
    }));
    assert.equal(normalized.address, TOKEN);
    assert.equal(normalized.holderCount, 105);
    assert.equal(holderEvents.normalizeRobinhoodHolderEvent(realtime({ holderCount: 2 ** 53 })), null);
    assert.equal(holderEvents.normalizeRobinhoodHolderEvent(realtime({ holderCount: '' })), null);
    assert.equal(holderEvents.normalizeRobinhoodHolderEvent(realtime({ sequence: 'wrong' })), null);
    assert.equal(holderEvents.normalizeRobinhoodHolderEvent(realtime({ chain: 'base' })), null);
  });

  it('orders count and invalidation events by ledger version per token', () => {
    const gate = holderEvents.createRobinhoodHolderEventOrderGate();
    const count = holderEvents.normalizeRobinhoodHolderEvent(realtime());
    const invalidation = holderEvents.normalizeRobinhoodHolderEvent(realtime({
      type: 'holder:invalidate', holderCount: undefined, ledgerVersion: '8',
      sequence: `robinhood-holder:${TOKEN}:000000000000000000000008`, reason: 'reorg_resync',
    }));
    assert.equal(gate.accept(count), true);
    assert.equal(gate.accept(count), false);
    assert.equal(gate.accept(invalidation), true);
    assert.equal(gate.accept(count), false);
  });

  it('patches only the current hour and requests REST recovery across an hour boundary', () => {
    const current = history();
    const event = holderEvents.normalizeRobinhoodHolderEvent(realtime());
    const patched = holderEvents.patchRobinhoodHolderSeries(current, event);

    assert.equal(patched.current.holderCount, 105);
    assert.equal(patched.deltas['4h'].delta, 10);
    assert.equal(patched.series['1h'][0].delta, 7);
    assert.equal(patched.series['24h'][0].delta, 25);
    assert.equal(current.current.holderCount, 100);
    const nextHour = holderEvents.normalizeRobinhoodHolderEvent(realtime({
      observedAt: '2026-08-10T13:00:00.000Z', ledgerVersion: '8',
      sequence: `robinhood-holder:${TOKEN}:000000000000000000000008`,
    }));
    assert.equal(holderEvents.patchRobinhoodHolderSeries(patched, nextHour), null);
  });
});
