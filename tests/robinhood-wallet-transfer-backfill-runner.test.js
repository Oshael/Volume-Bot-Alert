const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  LEASE_KEY, runRobinhoodWalletTransferBackfill,
} = require('../src/services/robinhood-wallet-transfer-backfill-runner');

function harness(results = []) {
  const calls = [];
  const leaseStore = {
    acquire: async (...args) => { calls.push(['acquire', ...args]); return { ownerId: args[1] }; },
    heartbeat: async (...args) => {
      calls.push(['heartbeat', ...args]); return { ownerId: args[1] };
    },
    release: async (...args) => { calls.push(['release', ...args]); return true; },
  };
  let index = 0;
  return {
    calls, leaseStore,
    deps: {
      tickDeps: { marker: 'tick' }, leaseStore,
      setInterval: () => ({ unref() {} }), clearInterval: () => {},
      sleep: async (ms) => calls.push(['sleep', ms]),
      runCommit: async (tickDeps, input) => {
        calls.push(['commit', tickDeps, input]);
        return results[index++] || { status: 'projected', nextBlock: String(index) };
      },
    },
  };
}

describe('Robinhood wallet-transfer backfill runner', () => {
  it('holds one dedicated lease while advancing bounded ranges', async () => {
    const test = harness([
      { status: 'projected', nextBlock: '101' },
      { status: 'projected', nextBlock: '201' },
    ]);
    const result = await runRobinhoodWalletTransferBackfill({
      maxBlocks: 100, maxRanges: 2, pauseMs: 5, ownerId: 'runner-a',
    }, test.deps);

    assert.equal(result.status, 'range-limit');
    assert.equal(result.rangesCompleted, 2);
    assert.equal(test.calls.filter(([method]) => method === 'commit').length, 2);
    assert.deepEqual(test.calls.find(([method]) => method === 'sleep'), ['sleep', 5]);
    assert.equal(test.calls[0][0], 'acquire');
    assert.equal(test.calls[0][1], LEASE_KEY);
    assert.equal(test.calls.at(-1)[0], 'release');
  });

  it('does no work without the lease and stops on a terminal result', async () => {
    const unavailable = harness();
    unavailable.leaseStore.acquire = async () => null;
    const skipped = await runRobinhoodWalletTransferBackfill({}, unavailable.deps);
    assert.equal(skipped.status, 'lease-unavailable');
    assert.equal(unavailable.calls.some(([method]) => method === 'commit'), false);

    const terminal = harness([{ status: 'blocked', reason: 'checkpoint_mismatch' }]);
    const stopped = await runRobinhoodWalletTransferBackfill({
      maxRanges: 10, ownerId: 'runner-b',
    }, terminal.deps);
    assert.equal(stopped.status, 'blocked');
    assert.equal(stopped.rangesCompleted, 1);
    assert.equal(terminal.calls.filter(([method]) => method === 'commit').length, 1);
    assert.equal(terminal.calls.some(([method]) => method === 'sleep'), false);
  });

  it('stops before the next range when heartbeat ownership is lost', async () => {
    const test = harness([{ status: 'projected', nextBlock: '101' }]);
    test.leaseStore.heartbeat = async () => null;
    const result = await runRobinhoodWalletTransferBackfill({
      maxRanges: 5, ownerId: 'runner-c',
    }, test.deps);
    assert.equal(result.status, 'lease-lost');
    assert.equal(result.rangesCompleted, 1);
    assert.equal(test.calls.filter(([method]) => method === 'commit').length, 1);
    assert.equal(test.calls.at(-1)[0], 'release');
  });
});
