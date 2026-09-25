'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { it } = require('node:test');
const { createPostgresRealtimeListener } = require('../src/services/postgres-realtime-listener');

function fakePool() {
  const clients = [];
  let connects = 0;
  return {
    clients,
    get connects() { return connects; },
    async connect() {
      connects += 1;
      const client = new EventEmitter();
      client.queries = [];
      client.releases = [];
      client.query = async (sql) => { client.queries.push(sql); };
      client.release = (error) => { client.releases.push(error || null); };
      clients.push(client);
      return client;
    },
  };
}

const silent = { log() {}, error() {} };

it('shares one connection, routes notifications, and releases it after the last stop', async () => {
  const pool = fakePool();
  const received = [];
  const first = createPostgresRealtimeListener({ shared: true, pool, channel: 'mint_queue',
    logger: silent, onNotification: () => received.push('mint') });
  const second = createPostgresRealtimeListener({ shared: true, pool, channel: 'swap_queue',
    logger: silent, onNotification: () => received.push('swap') });
  await Promise.all([first.start(), second.start()]);
  assert.equal(pool.connects, 1);
  assert.deepEqual(pool.clients[0].queries, ['LISTEN mint_queue', 'LISTEN swap_queue']);
  pool.clients[0].emit('notification', { channel: 'swap_queue' });
  pool.clients[0].emit('notification', { channel: 'mint_queue' });
  assert.deepEqual(received, ['swap', 'mint']);
  await first.stop();
  assert.equal(second.getStatus().listening, true);
  assert.equal(pool.clients[0].releases.length, 0);
  assert.equal(pool.clients[0].queries.at(-1), 'UNLISTEN mint_queue');
  await second.stop();
  assert.equal(pool.clients[0].queries.at(-1), 'UNLISTEN *');
  assert.deepEqual(pool.clients[0].releases, [null]);
});

it('reconnects all channels on transport loss without multiplying clients', async () => {
  const pool = fakePool();
  let retry;
  const timers = { setTimeoutFn: (callback) => { retry = callback; return { unref() {} }; },
    clearTimeoutFn() {} };
  const listeners = ['mint_queue', 'swap_queue'].map((channel) =>
    createPostgresRealtimeListener({ shared: true, pool, channel, logger: silent,
      ...timers }));
  await Promise.all(listeners.map((listener) => listener.start()));
  pool.clients[0].emit('error', new Error('connection lost'));
  assert.equal(listeners[0].getStatus().listening, false);
  assert.equal(listeners[1].getStatus().reconnectScheduled, true);
  retry();
  for (let attempt = 0; attempt < 5 && !listeners[0].getStatus().listening; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(pool.connects, 2);
  assert.deepEqual(pool.clients[1].queries, ['LISTEN mint_queue', 'LISTEN swap_queue']);
  assert.equal(listeners[0].getStatus().successfulReconnects, 1);
  assert.equal(listeners[1].getStatus().successfulReconnects, 1);
  await Promise.all(listeners.map((listener) => listener.stop()));
});

it('keeps a shared channel subscribed while another consumer remains', async () => {
  const pool = fakePool();
  const channels = [];
  const listeners = [1, 2].map((id) => createPostgresRealtimeListener({ shared: true, pool,
    channel: 'mint_queue', logger: silent, onNotification: () => channels.push(id) }));
  await Promise.all(listeners.map((listener) => listener.start()));
  assert.deepEqual(pool.clients[0].queries, ['LISTEN mint_queue']);
  await listeners[0].stop();
  assert.deepEqual(pool.clients[0].queries, ['LISTEN mint_queue']);
  pool.clients[0].emit('notification', { channel: 'mint_queue' });
  assert.deepEqual(channels, [2]);
  await listeners[1].stop();
});

it('subscribes a channel added after connection and retries initial pool timeout', async () => {
  const pool = fakePool();
  const originalConnect = pool.connect;
  let attempts = 0;
  pool.connect = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('timeout exceeded when trying to connect');
    return originalConnect();
  };
  let retry;
  const first = createPostgresRealtimeListener({ shared: true, pool,
    channel: 'mint_queue', logger: silent,
    setTimeoutFn: (callback) => { retry = callback; return { unref() {} }; } });
  await assert.rejects(first.start(), /timeout exceeded/);
  assert.equal(first.getStatus().reconnectScheduled, true);
  const queued = createPostgresRealtimeListener({ shared: true, pool,
    channel: 'launch_queue', logger: silent });
  await queued.start();
  assert.equal(attempts, 1);
  retry();
  for (let attempt = 0; attempt < 5 && !first.getStatus().listening; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(first.getStatus().listening, true);
  const second = createPostgresRealtimeListener({ shared: true, pool,
    channel: 'swap_queue', logger: silent });
  await second.start();
  assert.equal(pool.connects, 1);
  assert.deepEqual(pool.clients[0].queries,
    ['LISTEN mint_queue', 'LISTEN launch_queue', 'LISTEN swap_queue']);
  await Promise.all([first.stop(), queued.stop(), second.stop()]);
});

it('marks a late subscriber ready only after its LISTEN finishes', async () => {
  const pool = fakePool();
  let firstEntered;
  let secondEntered;
  let releaseFirst;
  let releaseSecond;
  const enteredFirst = new Promise((resolve) => { firstEntered = resolve; });
  const enteredSecond = new Promise((resolve) => { secondEntered = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const connect = pool.connect;
  pool.connect = async () => {
    const client = await connect();
    client.query = async (sql) => {
      client.queries.push(sql);
      if (sql === 'LISTEN mint_queue') { firstEntered(); await firstGate; }
      if (sql === 'LISTEN swap_queue') { secondEntered(); await secondGate; }
    };
    return client;
  };
  const first = createPostgresRealtimeListener({ shared: true, pool,
    channel: 'mint_queue', logger: silent });
  const second = createPostgresRealtimeListener({ shared: true, pool,
    channel: 'swap_queue', logger: silent });
  const startedFirst = first.start();
  await enteredFirst;
  const startedSecond = second.start();
  releaseFirst();
  await enteredSecond;
  assert.equal(second.getStatus().listening, false);
  releaseSecond();
  await Promise.all([startedFirst, startedSecond]);
  assert.equal(second.getStatus().listening, true);
  await Promise.all([first.stop(), second.stop()]);
});

it('discards the shared client if the final UNLISTEN fails', async () => {
  const pool = fakePool();
  const listener = createPostgresRealtimeListener({ shared: true, pool,
    channel: 'mint_queue', logger: silent });
  await listener.start();
  pool.clients[0].query = async (sql) => {
    if (sql === 'UNLISTEN *') throw new Error('connection closed');
  };
  await listener.stop();
  assert.match(pool.clients[0].releases[0].message, /connection closed/);
});
