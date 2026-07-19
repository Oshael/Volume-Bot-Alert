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
