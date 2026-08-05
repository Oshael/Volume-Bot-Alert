const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  CHANNEL,
  createMarketBucketRealtime,
} = require('../src/services/market-bucket-realtime');

function marketEvent(sequence, volumeUsd = 10) {
  return {
    chain: 'robinhood',
    address: '0x1111111111111111111111111111111111111111',
    bucketTs: '2026-07-18T22:00:00.000Z',
    sequence,
    activity: { volumeUsd, swaps: Number(sequence) },
  };
}

test('coalesces each token and publishes the latest committed bucket in one query', async () => {
  const calls = [];
  const relay = createMarketBucketRealtime({
    database: { query: async (...args) => calls.push(args) },
    schedule: () => ({ timer: true }),
    cancel: () => {},
  });

  assert.equal(relay.enqueue(marketEvent('1')), true);
  assert.equal(relay.enqueue(marketEvent('2', 25)), true);
  assert.equal(await relay.flush(), true);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][1][0], CHANNEL);
  assert.equal(calls[0][1][1].length, 1);
  assert.equal(JSON.parse(calls[0][1][1][0]).activity.volumeUsd, 25);
  assert.equal(relay.getStatus().coalesced, 1);
});

test('requeues a batch after a transient publish failure', async () => {
  const delays = [];
  const relay = createMarketBucketRealtime({
    database: { query: async () => { throw new Error('offline'); } },
    schedule: (_, delay) => { delays.push(delay); return { timer: true }; },
    cancel: () => {},
    logger: { error: () => {}, log: () => {} },
  });

  relay.enqueue(marketEvent('1'));
  assert.equal(await relay.flush(), false);
  assert.equal(relay.getStatus().pending, 1);
  assert.equal(delays.at(-1), 250);
});

test('direct publish resolves only after pg_notify succeeds and propagates failures', async () => {
  const calls = [];
  const relay = createMarketBucketRealtime({
    database: { query: async (...args) => calls.push(args) },
    logger: { error: () => {}, log: () => {} },
  });

  assert.equal(await relay.publish(marketEvent('1')), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1].slice(0, 1), [CHANNEL]);

  const failing = createMarketBucketRealtime({
    database: { query: async () => { throw new Error('offline'); } },
    logger: { error: () => {}, log: () => {} },
  });
  await assert.rejects(failing.publish(marketEvent('2')), /offline/);
  assert.equal(failing.getStatus().publishFailures, 1);
});

test('LISTEN forwards a valid notification to the local socket hub', async () => {
  const client = new EventEmitter();
  const queries = [];
  client.query = async (sql) => queries.push(sql);
  client.release = () => {};
  const emitted = [];
  const relay = createMarketBucketRealtime({
    socketHub: { emitMarketBucketUpdate: (event) => emitted.push(event) },
    logger: { error: () => {}, log: () => {} },
  });

  await relay.start({ pool: { connect: async () => client } });
  client.emit('notification', { channel: CHANNEL, payload: JSON.stringify(marketEvent('3')) });
  client.emit('notification', { channel: 'other', payload: '{}' });

  assert.match(queries[0], new RegExp(`LISTEN ${CHANNEL}`));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, 'market:bucket');
  await relay.stop();
  assert.match(queries[1], new RegExp(`UNLISTEN ${CHANNEL}`));
});

test('reconnects LISTEN after connection loss and cancels recovery on stop', async () => {
  class FakeClient extends EventEmitter {
    constructor() {
      super();
      this.queries = [];
      this.released = false;
    }

    async query(sql) {
      this.queries.push(sql);
    }

    release() {
      this.released = true;
    }
  }

  const clients = [new FakeClient(), new FakeClient()];
  const reconnectCallbacks = [];
  let connectCalls = 0;
  let cancelledTimers = 0;
  const relay = createMarketBucketRealtime({ logger: { error: () => {}, log: () => {} } });
  await relay.start({
    pool: { connect: async () => clients[connectCalls++] },
    reconnectDelayMs: 10,
    setTimeoutFn(callback) {
      reconnectCallbacks.push(callback);
      return { unref() {} };
    },
    clearTimeoutFn() {
      cancelledTimers += 1;
    },
  });

  clients[0].emit('error', new Error('connection terminated'));
  assert.equal(relay.getStatus().listening, false);
  assert.equal(relay.getStatus().reconnectScheduled, true);
  reconnectCallbacks.shift()();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(connectCalls, 2);
  assert.deepEqual(clients[1].queries, [`LISTEN ${CHANNEL}`]);
  assert.equal(relay.getStatus().listening, true);
  assert.equal(relay.getStatus().successfulReconnects, 1);

  clients[1].emit('end');
  await relay.stop();
  assert.equal(cancelledTimers, 1);
  assert.equal(relay.getStatus().running, false);
  assert.equal(relay.getStatus().reconnectScheduled, false);
});

test('does not return to listening when stop overlaps the initial LISTEN query', async () => {
  const client = new EventEmitter();
  const queries = [];
  let resolveListen = null;
  client.query = async (sql) => {
    queries.push(sql);
    if (sql === `LISTEN ${CHANNEL}`) {
      await new Promise((resolve) => { resolveListen = resolve; });
    }
  };
  client.release = () => {};
  const relay = createMarketBucketRealtime({ logger: { error: () => {}, log: () => {} } });

  const startPromise = relay.start({ pool: { connect: async () => client } });
  await new Promise((resolve) => setImmediate(resolve));
  const stopPromise = relay.stop();
  resolveListen();
  await Promise.all([startPromise, stopPromise]);

  assert.deepEqual(queries, [`LISTEN ${CHANNEL}`, `UNLISTEN ${CHANNEL}`]);
  assert.equal(relay.getStatus().running, false);
  assert.equal(relay.getStatus().listening, false);
});
