const assert = require('node:assert/strict');
const { it } = require('node:test');
const {
  createRobinhoodFreshWalletLiveQueueRepository,
} = require('../src/models/robinhood-fresh-wallet-live-queue');

it('reclaims expired leases separately so pending claims retain their partial-index shape', async () => {
  const calls = [];
  const repository = createRobinhoodFreshWalletLiveQueueRepository({ database: {
    async query(sql, params) { calls.push({ sql, params }); return { rows: [] }; },
  } });
  assert.deepEqual(await repository.claimBatch({ owner: 'test', limit: 100 }), []);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /status = 'leased'.*lease_until <= NOW\(\)/s);
  assert.match(calls[0].sql, /ORDER BY queue\.lease_until[\s\S]*SKIP LOCKED/);
  assert.match(calls[1].sql, /queue\.status = 'pending'/);
  assert.doesNotMatch(calls[1].sql, /queue\.status = 'leased'/);
  assert.match(calls[1].sql, /ORDER BY queue\.next_attempt_at, queue\.updated_at/);
  assert.deepEqual(calls[1].params.slice(0, 3), ['robinhood', 'rh_fresh_signed_v1', 100]);
});
