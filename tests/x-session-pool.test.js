'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionPool } = require('../src/services/x-session-pool');

function fakeModel(list) {
  const calls = { quarantine: [], updateCt0: [], markUsed: [] };
  return {
    calls,
    listActive: async () => list.map((s) => ({ ...s })),
    quarantine: async (id, until) => calls.quarantine.push({ id, until }),
    updateCt0: async (id, ct0) => calls.updateCt0.push({ id, ct0 }),
    markUsed: async (id) => calls.markUsed.push({ id }),
  };
}

test('acquire returns an active session after refresh', async () => {
  const pool = createSessionPool({ model: fakeModel([{ id: 1, ct0: 'a' }]), now: () => 1000 });
  assert.equal(await pool.refresh(), 1);
  assert.equal(pool.acquire('timeline').id, 1);
});

test('an exhausted bucket blocks acquire until the reset window passes', async () => {
  let nowMs = 1000;
  const pool = createSessionPool({ model: fakeModel([{ id: 1, ct0: 'a' }]), now: () => nowMs });
  await pool.refresh();
  const session = pool.acquire('timeline');
  await pool.report(session, 'timeline', { status: 200, rateLimit: { remaining: 0, resetMs: 5000 } });
  assert.equal(pool.acquire('timeline'), null, 'no budget -> no session');
  nowMs = 6000; // past reset
  assert.equal(pool.acquire('timeline').id, 1, 'window rolled over -> available again');
});

test('a 403 quarantines the session and drops it from the pool', async () => {
  const model = fakeModel([{ id: 1 }, { id: 2 }]);
  const pool = createSessionPool({ model, now: () => 1000, quarantineMs: 60_000 });
  await pool.refresh();
  const session = pool.acquire('timeline');
  await pool.report(session, 'timeline', { status: 403 });
  assert.equal(model.calls.quarantine.length, 1);
  assert.equal(model.calls.quarantine[0].until, 61_000);
  assert.equal(pool.size(), 1);
});

test('a rotated ct0 is persisted and updated in memory', async () => {
  const model = fakeModel([{ id: 1, ct0: 'OLD' }]);
  const pool = createSessionPool({ model, now: () => 1000 });
  await pool.refresh();
  const session = pool.acquire('timeline');
  await pool.report(session, 'timeline', { status: 200, newCt0: 'NEW' });
  assert.deepEqual(model.calls.updateCt0, [{ id: 1, ct0: 'NEW' }]);
  assert.equal(session.ct0, 'NEW');
});

test('acquire rotates least-recently-used across sessions', async () => {
  let nowMs = 1000;
  const pool = createSessionPool({ model: fakeModel([{ id: 1 }, { id: 2 }]), now: () => nowMs });
  await pool.refresh();
  const first = pool.acquire('timeline');
  nowMs = 1001;
  const second = pool.acquire('timeline');
  assert.notEqual(first.id, second.id, 'second acquire picks the other session');
});
