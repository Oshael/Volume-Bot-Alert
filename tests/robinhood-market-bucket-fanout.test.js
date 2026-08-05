const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  createRobinhoodMarketBucketFanout,
} = require('../src/services/robinhood-market-bucket-fanout');

function fakes(returns = {}) {
  const calls = { socket: 0, relay: 0, catalog: 0, alert: 0, aggregate: 0 };
  const seen = {};
  const sink = (name, ret) => ({
    enqueue: (payload) => { calls[name] += 1; seen[name] = payload; return ret; },
  });
  const deps = {
    socketHub: {
      emitMarketBucketUpdate: (payload) => {
        calls.socket += 1; seen.socket = payload; return returns.socket ?? false;
      },
    },
    marketBucketRealtime: sink('relay', returns.relay ?? true),
    liveCatalogWorker: sink('catalog', returns.catalog ?? true),
    realtimeAlertWorker: sink('alert', returns.alert ?? true),
    marketAggregateWorker: sink('aggregate', returns.aggregate ?? true),
  };
  return { deps, calls, seen };
}

describe('robinhood market bucket fan-out', () => {
  it('skips the relay when a local socket already received the update', () => {
    const { deps, calls } = fakes({ socket: true });
    const fanout = createRobinhoodMarketBucketFanout(deps);

    assert.equal(fanout({ address: '0xabc' }), true);
    assert.equal(calls.socket, 1);
    // Socket-first: a local delivery must not also publish to the relay.
    assert.equal(calls.relay, 0);
    // The in-memory workers are fed regardless of the socket outcome.
    assert.equal(calls.catalog, 1);
    assert.equal(calls.alert, 1);
    assert.equal(calls.aggregate, 1);
  });

  it('queues the relay and feeds the workers when no local socket received it', () => {
    const { deps, calls, seen } = fakes({ socket: false });
    const fanout = createRobinhoodMarketBucketFanout(deps);
    const payload = { address: '0xabc' };

    assert.equal(fanout(payload), true);
    assert.equal(calls.relay, 1);
    assert.equal(seen.relay, payload);
    assert.equal(calls.catalog, 1);
    assert.equal(calls.alert, 1);
    assert.equal(calls.aggregate, 1);
  });

  it('returns false only when no sink accepts the update', () => {
    const { deps } = fakes({
      socket: false, relay: false, catalog: false, alert: false, aggregate: false,
    });
    const fanout = createRobinhoodMarketBucketFanout(deps);

    assert.equal(fanout({ address: '0xabc' }), false);
  });
});
