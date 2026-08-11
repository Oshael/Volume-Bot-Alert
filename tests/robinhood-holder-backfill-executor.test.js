const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodHolderBackfillExecutor,
  __private,
} = require('../src/services/robinhood-holder-backfill-executor');

const TOKEN = `0x${'1'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;

function state(overrides = {}) {
  return {
    tokenAddress: TOKEN, deploymentBlock: '100', backfillNextBlock: '103',
    liveThroughBlock: '102', liveThroughHash: HASH, version: 2, ...overrides,
  };
}

describe('Robinhood holder backfill executor', () => {
  it('commits one confirmed bounded range and stops at the handoff barrier', async () => {
    const calls = [];
    const repository = {
      getNextToken: async (input) => {
        calls.push(['select', input]);
        return state();
      },
      markResyncing: async () => { throw new Error('must not isolate'); },
      async commitRange(range) {
        calls.push(['commit', range]);
        return {
          status: 'committed', tokenAddress: TOKEN, transfers: 0, touchedWallets: 0,
          holderDelta: 0, holderCount: '10', backfillNextBlock: '106',
          liveThroughBlock: '105', liveThroughHash: HASH, version: 3,
        };
      },
    };
    const reader = {
      getSafeHead: async (confirmations) => {
        calls.push(['head', confirmations]);
        return { head: '117', safeHead: '105', confirmations };
      },
      matchesCheckpoint: async (checkpoint) => {
        calls.push(['checkpoint', checkpoint]);
        return true;
      },
      readRange: async (range) => {
        calls.push(['read', range]);
        return { ...range, checkpoint: { number: '105', hash: HASH }, transfers: [] };
      },
    };
    const result = await createRobinhoodHolderBackfillExecutor({
      repository, reader,
    }).runOnce({ rangeSize: 50, confirmations: 12 });

    assert.equal(result.atBarrier, true);
    assert.deepEqual(calls, [
      ['head', 12],
      ['select', { throughBlock: '105' }],
      ['checkpoint', { number: '102', hash: HASH }],
      ['read', { tokenAddress: TOKEN, fromBlock: '103', toBlock: '105' }],
      ['commit', {
        tokenAddress: TOKEN, fromBlock: '103', toBlock: '105',
        checkpoint: { number: '105', hash: HASH }, transfers: [],
      }],
    ]);
  });

  it('isolates an orphaned checkpoint without reading or committing another range', async () => {
    const calls = [];
    const repository = {
      getNextToken: async () => state(),
      commitRange: async () => { throw new Error('must not commit'); },
      markResyncing: async (value) => {
        calls.push(value);
        return { status: 'resyncing', tokenAddress: value.tokenAddress };
      },
    };
    const reader = {
      getSafeHead: async () => ({ head: '120', safeHead: '108', confirmations: 12 }),
      matchesCheckpoint: async () => false,
      readRange: async () => { throw new Error('must not read'); },
    };
    const result = await createRobinhoodHolderBackfillExecutor({ repository, reader }).runOnce();

    assert.deepEqual(result, {
      status: 'resyncing', tokenAddress: TOKEN,
      reason: 'holder_backfill_checkpoint_orphaned',
    });
    assert.equal(calls.length, 1);
  });

  it('requires three identical deficit readings before isolating drift', async () => {
    const commits = [];
    const fingerprints = ['original', 'original', 'changed', 'changed', 'changed'];
    const repository = {
      getNextToken: async () => state(),
      markResyncing: async () => { throw new Error('must not resync'); },
      commitRange: async (range) => {
        commits.push(range);
        return range.confirmDrift
          ? { status: 'drifted', tokenAddress: TOKEN, reason: 'holder_negative_balance' }
          : { status: 'drift-suspected', tokenAddress: TOKEN,
            reason: 'holder_negative_balance', fingerprint: fingerprints.shift() };
      },
    };
    const reader = {
      getSafeHead: async () => ({ safeHead: '105' }),
      matchesCheckpoint: async () => true,
      readRange: async (range) => ({
        ...range, checkpoint: { number: '105', hash: HASH }, transfers: [],
      }),
    };
    const executor = createRobinhoodHolderBackfillExecutor({ repository, reader });

    const first = await executor.runOnce();
    const second = await executor.runOnce();
    const third = await executor.runOnce();
    const fourth = await executor.runOnce();
    const fifth = await executor.runOnce();

    assert.equal(first.status, 'drift-suspected');
    assert.equal(first.observations, 1);
    assert.equal(second.observations, 2);
    assert.equal(third.status, 'drift-suspected');
    assert.equal(third.observations, 1);
    assert.equal(fourth.observations, 2);
    assert.equal(fifth.status, 'drifted');
    assert.equal(fifth.observations, 3);
    assert.equal(commits.length, 6);
    assert.equal(commits.filter(({ confirmDrift }) => confirmDrift === true).length, 1);
  });

  it('requires the configured Robinhood RPC and never falls back to dRPC', () => {
    assert.deepEqual(__private.resolveRpcProvider({ ROBINHOOD_RPC_URL: 'http://127.0.0.1:8547' }), {
      name: 'robinhood-holder-backfill', url: 'http://127.0.0.1:8547',
    });
    assert.throws(
      () => __private.resolveRpcProvider({ ROBINHOOD_DRPC_RPC_URL: 'https://drpc.invalid' }),
      /ROBINHOOD_RPC_URL is required/
    );
  });
});
