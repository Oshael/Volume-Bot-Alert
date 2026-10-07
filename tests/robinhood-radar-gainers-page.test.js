const assert = require('node:assert/strict');
const { it } = require('node:test');
const { createRobinhoodRadarGainersPage } = require('../src/services/robinhood-radar-gainers-page');

const START = Date.parse('2026-10-06T12:00:45Z');
const address = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const items = Array.from({ length: 20 }, (_, i) => ({
  identity: { chain: 'robinhood', address: address(i + 1), key: `robinhood:${address(i + 1)}` },
  priceChangePct: '123.4567890123456789', priceBasis: { coverage: 'available-history' },
}));

function harness() {
  let time = START;
  let blocked = [];
  let reorgRevision = '0';
  let priceRevision = '0';
  let source = async (query) => ({ chain: 'robinhood', asOf: query.asOf,
    limit: 20, total: 25, candidateCount: 30, unpricedCount: 5, items });
  const calls = [];
  const reads = [];
  const page = createRobinhoodRadarGainersPage({ now: () => time,
    getReorgRevision: () => reorgRevision,
    getPriceRevision: () => priceRevision,
    service: { getGainers(query) { calls.push(query); return source(query); } },
    database: { async queryWithStatementTimeout(_sql, params, timeout) {
      assert.equal(timeout, 1000);
      reads.push(params);
      return { rows: blocked.map((value) => ({ address: value })) };
    } },
  });
  return { page, calls, reads, advance(ms) { time += ms; },
    block(values) { blocked = values; }, source(value) { source = value; },
    reorg() { reorgRevision = String(BigInt(reorgRevision) + 1n); },
    price() { priceRevision = String(BigInt(priceRevision) + 1n); } };
}

it('shares equivalent users/limits, normalizes exclusions before selection and expires cached reads', async () => {
  const h = harness();
  h.block([address(23).toUpperCase().replace('0X', '0x')]);
  const first = await h.page.list(10, { limit: 1,
    dismissedIdentities: [24, 23, 24].map((n) => `robinhood:${address(n)}`) });
  assert.equal(first.items.length, 1);
  assert.equal(first.hasMore, true);
  assert.equal(first.items[0].priceChangePct, items[0].priceChangePct);
  assert.equal(first.candidateCount, 30);
  assert.deepEqual(h.calls[0], { asOf: '2026-10-06T12:00:45.000Z', live: true,
    excludedAddresses: [address(23), address(24)], limit: 20 });
  h.advance(1000);
  const second = await h.page.list(20, { dismissedIdentities: [`robinhood:${address(24)}`] });
  assert.equal(second.limit, 15);
  assert.equal(second.items.length, 15);
  assert.equal(second.generatedAt, first.generatedAt);
  assert.equal(second.cacheAgeMs, 1000);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.reads, [[10], [20]]);
  h.advance(4000);
  await h.page.list(20, { dismissedIdentities: [`robinhood:${address(24)}`] });
  assert.equal(h.calls.length, 2);
  h.advance(10000);
  await h.page.list(20, { dismissedIdentities: [`robinhood:${address(24)}`] });
  assert.equal(h.calls[2].asOf, '2026-10-06T12:01:00.000Z');
  const boundary = harness();
  boundary.advance(14000);
  await boundary.page.list(1);
  boundary.advance(250); boundary.price(); // A committed price supersedes the cached generation.
  await assert.rejects(boundary.page.list(1), { code: 'GAINERS_BUSY', retryAfterSeconds: 1 });
  boundary.advance(250);
  await boundary.page.list(1);
  assert.equal(boundary.calls[1].asOf, '2026-10-06T12:00:59.500Z');
});

it('bounds simultaneous waiters, rejects other exclusions without queueing and keeps changes isolated', async () => {
  const h = harness();
  let release;
  h.source(() => new Promise((resolve) => { release = resolve; }));
  const pending = Array.from({ length: 32 }, (_, user) => h.page.list(user));
  await new Promise(setImmediate);
  assert.equal(h.calls.length, 1);
  await assert.rejects(h.page.list(33), { code: 'GAINERS_BUSY' });
  await assert.rejects(h.page.list(34, { dismissedIdentities: [`robinhood:${address(25)}`] }),
    { code: 'GAINERS_BUSY' });
  release({ chain: 'robinhood', asOf: h.calls[0].asOf, total: 0, items: [] });
  assert.equal((await Promise.all(pending)).length, 32);
  h.block([address(25)]);
  await assert.rejects(h.page.list(0), { code: 'GAINERS_BUSY', retryAfterSeconds: 1 });
  h.advance(5000);
  h.source(async (query) => ({ chain: 'robinhood', asOf: query.asOf, total: 0, items: [] }));
  const empty = await h.page.list(0);
  assert.deepEqual(h.calls[1].excludedAddresses, [address(25)]);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.hasMore, false);
});

it('publishes an honest in-flight price snapshot and catches up without waiting for the next minute', async () => {
  const h = harness(); let release;
  h.source(() => new Promise((resolve) => { release = resolve; }));
  const pending = h.page.list(1); await new Promise(setImmediate);
  h.price();
  release({ chain: 'robinhood', asOf: h.calls[0].asOf, total: 0, items: [] });
  assert.equal((await pending).asOf, '2026-10-06T12:00:45.000Z');
  h.advance(500);
  h.source(async (query) => ({ chain: 'robinhood', asOf: query.asOf, total: 0, items: [] }));
  assert.equal((await h.page.list(1)).asOf, '2026-10-06T12:00:45.500Z');
  assert.equal(h.calls.length, 2);
});

it('clears failed work, backs off and never fabricates/cache-publishes an empty success', async () => {
  const h = harness();
  h.source(async () => { throw new Error('database down'); });
  await assert.rejects(h.page.list(1), /database down/);
  await assert.rejects(h.page.list(1), { code: 'GAINERS_BUSY', retryAfterSeconds: 10 });
  h.advance(10000);
  h.source(async (query) => ({ chain: 'robinhood', asOf: query.asOf, total: 0, items: [] }));
  assert.equal((await h.page.list(1)).total, 0);
  assert.equal(h.calls.length, 2);
});

it('cannot reuse or publish a snapshot from before a durably observed reorg', async () => {
  const h = harness();
  await h.page.list(1);
  h.reorg();
  await assert.rejects(h.page.list(1), { code: 'GAINERS_BUSY' });
  h.advance(5000);
  let release;
  h.source(() => new Promise((resolve) => { release = resolve; }));
  const pending = h.page.list(1);
  await new Promise(setImmediate);
  h.reorg();
  const rejected = assert.rejects(pending, { code: 'GAINERS_BUSY' });
  release({ chain: 'robinhood', asOf: h.calls[1].asOf, total: 0, items: [] });
  await rejected;
  h.advance(5000);
  h.source(async (query) => ({ chain: 'robinhood', asOf: query.asOf, total: 0, items: [] }));
  assert.equal((await h.page.list(1)).total, 0);
  assert.equal(h.calls.length, 3);
});

it('rejects malformed, cross-chain, historical and oversized requests before database work', async () => {
  const h = harness();
  for (const input of [null, [], { limit: '15' }, { limit: 0 }, { limit: 21 },
    { asOf: '2020-01-01' }, { chain: 'solana' }, { dismissedIdentities: {} },
    { dismissedIdentities: [address(1)] }, { dismissedIdentities: [`base:${address(1)}`] },
    { dismissedIdentities: Array(5001).fill(`robinhood:${address(1)}`) }]) {
    await assert.rejects(h.page.list(1, input), { code: 'INVALID_GAINERS_REQUEST' });
  }
  assert.equal(h.reads.length, 0);
  h.block(Array(5001).fill(address(1)));
  await assert.rejects(h.page.list(1), { code: 'GAINERS_UNAVAILABLE' });
  h.block(Array.from({ length: 5000 }, (_, i) => address(i + 1)));
  await assert.rejects(h.page.list(1, { dismissedIdentities: [`robinhood:${address(5001)}`] }),
    { code: 'INVALID_GAINERS_REQUEST' });
  assert.equal(h.calls.length, 0);
});
