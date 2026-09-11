const assert = require('node:assert/strict');
const { it } = require('node:test');
const {
  createRobinhoodLaunchAnchorLiveWorker,
} = require('../src/services/robinhood-launch-anchor-live-worker');

const TOKEN = `0x${'a'.repeat(40)}`;

it('materializes an anchor before acknowledging its durable task', async () => {
  const calls = [];
  const repository = {
    claim: async () => ({ tokenAddress: TOKEN, attemptCount: 1 }),
    materialize: async () => { calls.push('materialize'); return true; },
    complete: async () => { calls.push('complete'); return true; },
    retry: async () => { calls.push('retry'); },
  };
  const result = await createRobinhoodLaunchAnchorLiveWorker({
    repository, owner: 'test',
  }).runOnce();
  assert.deepEqual(result, { status: 'materialized', tokenAddress: TOKEN });
  assert.deepEqual(calls, ['materialize', 'complete']);
});

it('defers tokens whose PostgreSQL launch inputs are not ready', async () => {
  const calls = [];
  const repository = {
    claim: async () => ({ tokenAddress: TOKEN, attemptCount: 2 }),
    materialize: async () => false,
    complete: async () => calls.push('complete'),
    retry: async (input) => calls.push(input),
  };
  const worker = createRobinhoodLaunchAnchorLiveWorker({ repository, owner: 'test' });
  assert.deepEqual(await worker.runOnce(), {
    status: 'deferred', reason: 'anchor_not_ready', tokenAddress: TOKEN,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].retryMs, 30_000);
  assert.match(calls[0].error, /anchor_not_ready/);
  assert.equal(worker.getStatus().totalDeferred, 1);
  assert.equal(worker.getStatus().lastError, null);
});

it('acknowledges permanently ineligible tokens instead of retrying forever', async () => {
  const calls = [];
  const repository = {
    claim: async () => ({ tokenAddress: TOKEN, attemptCount: 163 }),
    materialize: async () => ({ status: 'ineligible', reason: 'holder_missing' }),
    complete: async (input) => { calls.push(['complete', input]); return true; },
    retry: async (input) => calls.push(['retry', input]),
  };
  const worker = createRobinhoodLaunchAnchorLiveWorker({ repository, owner: 'test' });
  assert.deepEqual(await worker.runOnce(), {
    status: 'discarded', reason: 'holder_missing', tokenAddress: TOKEN,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'complete');
  assert.equal(worker.getStatus().totalDiscarded, 1);
  assert.equal(worker.getStatus().activeToken, null);
  assert.equal(Number.isInteger(worker.getStatus().lastDurationMs), true);
});
