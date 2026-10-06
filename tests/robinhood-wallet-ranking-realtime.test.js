const assert = require('node:assert/strict');
const { getGainersReorgRevision } = require('../src/services/robinhood-radar-gainers-generation');
const { describe, it } = require('node:test');
const {
  CHANNEL, createRobinhoodWalletRankingRealtime,
} = require('../src/services/robinhood-wallet-ranking-realtime');

function harness() {
  let rows = [{ source: 'positions', version: '2' }];
  let connected;
  let time = 1000;
  let visible = true;
  let failEmit = false;
  const events = [];
  const timers = [];
  const queries = [];
  const runtime = createRobinhoodWalletRankingRealtime({
    database: { async queryWithStatementTimeout(sql, params, timeoutMs) {
      queries.push({ sql, params, timeoutMs });
      return { rows };
    } },
    listenerFactory(options) {
      connected = options;
      return {
        async start() { options.onConnected({ isReconnect: false }); },
        async stop() {},
        getStatus: () => ({ listening: true }),
      };
    },
    emitSignal(event) {
      if (failEmit) throw new Error('hub offline');
      events.push(event);
      return true;
    },
    visible: () => visible,
    now: () => time,
    setTimeoutFn(callback) {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn() {},
    logger: { error() {} },
  });
  return {
    runtime, events, timers, queries,
    notify(payload) { return connected.onNotification({
      channel: CHANNEL, payload: JSON.stringify(payload),
    }); },
    reconnect() { connected.onConnected({ isReconnect: true }); },
    setRows(value) { rows = value; },
    setVisible(value) { visible = value; },
    setFailEmit(value) { failEmit = value; },
    advance(ms) { time += ms; },
  };
}

describe('Robinhood wallet ranking realtime relay', () => {
  it('coalesces committed versions by source and rejects duplicates or foreign payloads', async () => {
    const test = harness();
    await test.runtime.start();
    assert.equal(test.queries[0].timeoutMs, 5000);
    test.advance(5);
    assert.equal(test.runtime.flush(), true);
    assert.deepEqual(test.events[0].revisions, { positions: '2' });

    assert.equal(test.notify({ chain: 'robinhood', source: 'positions', version: '2' }), false);
    assert.equal(test.notify({ chain: 'robinhood', source: 'prices', version: '1' }), true);
    assert.equal(test.notify({ chain: 'robinhood', source: 'prices', version: '3' }), true);
    assert.equal(test.notify({ chain: 'robinhood', source: 'positions', version: '4' }), true);
    assert.equal(test.notify({ chain: 'solana', source: 'prices', version: '5' }), false);
    assert.equal(test.notify({ chain: 'robinhood', source: 'prices', version: '9223372036854775808' }), false);
    test.advance(8);
    assert.equal(test.runtime.flush(), true);
    assert.deepEqual(test.events[1], {
      type: 'wallet-ranking:invalidate', chain: 'robinhood', version: 1,
      revisions: { prices: '3', positions: '4' },
      publishedAt: new Date(1013).toISOString(),
    });
    assert.equal(test.runtime.getStatus().coalesced, 1);
    assert.equal(test.runtime.getStatus().duplicates, 1);
    assert.equal(test.runtime.getStatus().invalid, 2);
    assert.equal(test.runtime.getStatus().lastRelayMs, 8);
    const reorg = String(BigInt(getGainersReorgRevision()) + 1n);
    assert.equal(test.notify({ chain: 'robinhood', source: 'reorg', version: reorg }), true);
    assert.equal(getGainersReorgRevision(), reorg);
    await test.runtime.stop();
  });

  it('recovers missed revisions after listener reconnect without replaying older ones', async () => {
    const test = harness();
    await test.runtime.start();
    test.runtime.flush();
    test.setRows([
      { source: 'positions', version: '1' },
      { source: 'transfers', version: '7' },
      { source: 'swaps', version: '3' },
    ]);
    test.reconnect();
    await test.runtime.reconcile();
    assert.equal(test.runtime.flush(), true);
    assert.deepEqual(test.events[1].revisions, { transfers: '7', swaps: '3' });
    assert.equal(test.runtime.getStatus().reconciled, 3);
    assert.equal(test.runtime.getStatus().pending, 0);
    await test.runtime.stop();
  });

  it('suppresses hidden Robinhood and retains a failed publication for retry', async () => {
    const test = harness();
    test.setVisible(false);
    await test.runtime.start();
    assert.equal(test.runtime.flush(), false);
    assert.equal(test.events.length, 0);
    assert.equal(test.runtime.getStatus().suppressed, 1);

    test.setVisible(true);
    test.setFailEmit(true);
    test.notify({ chain: 'robinhood', source: 'prices', version: '5' });
    assert.equal(test.runtime.flush(), false);
    assert.equal(test.runtime.getStatus().pending, 1);
    assert.equal(test.runtime.getStatus().publishFailures, 1);
    test.setFailEmit(false);
    assert.equal(test.runtime.flush(), true);
    assert.deepEqual(test.events[0].revisions, { prices: '5' });
    await test.runtime.stop();
  });
});
