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
      readReceiptRange: async () => { throw new Error('must not read receipts'); },
    };
    const result = await createRobinhoodHolderBackfillExecutor({
      repository, reader,
    }).runOnce({ rangeSize: 50, confirmations: 12 });

    assert.equal(result.atBarrier, true);
    assert.deepEqual(calls, [
      ['head', 12],
      ['select', {
        throughBlock: '105', excludeTokenAddresses: [], shardCount: 1, shardIndex: 0,
      }],
      ['checkpoint', { number: '102', hash: HASH }],
      ['read', { tokenAddress: TOKEN, fromBlock: '103', toBlock: '105' }],
      ['commit', {
        tokenAddress: TOKEN, fromBlock: '103', toBlock: '105',
        checkpoint: { number: '105', hash: HASH }, transfers: [],
      }],
    ]);
  });

  it('treats a cursor changed by concurrent handoff as superseded work', async () => {
    const stale = Object.assign(
      new Error('holder backfill token cursor is stale or unavailable'),
      { code: 'holder_backfill_cursor_stale' }
    );
    const repository = {
      getNextToken: async () => state(),
      markResyncing: async () => { throw new Error('must not isolate'); },
      commitRange: async () => { throw stale; },
    };
    const reader = {
      getSafeHead: async () => ({ safeHead: '105' }),
      matchesCheckpoint: async () => true,
      readRange: async (range) => ({
        ...range, checkpoint: { number: '105', hash: HASH }, transfers: [],
      }),
      readReceiptRange: async () => { throw new Error('must not read receipts'); },
    };

    const result = await createRobinhoodHolderBackfillExecutor({
      repository, reader,
    }).runOnce();

    assert.deepEqual(result, {
      status: 'superseded', tokenAddress: TOKEN,
      reason: 'holder_backfill_cursor_stale', expectedBackfillNextBlock: '103',
      safeHead: '105', atBarrier: false,
    });
  });

  it('forwards a deterministic shard to token selection', async () => {
    const selections = [];
    const repository = {
      getNextToken: async (input) => { selections.push(input); return null; },
      markResyncing: async () => { throw new Error('must not isolate'); },
      commitRange: async () => { throw new Error('must not commit'); },
    };
    const reader = {
      getSafeHead: async () => ({ safeHead: '105' }),
      matchesCheckpoint: async () => { throw new Error('must not verify'); },
      readRange: async () => { throw new Error('must not read'); },
      readReceiptRange: async () => { throw new Error('must not read receipts'); },
    };

    const result = await createRobinhoodHolderBackfillExecutor({
      repository, reader,
    }).runOnce({ shardCount: 4, shardIndex: 2 });

    assert.equal(result.status, 'idle');
    assert.deepEqual(selections, [{
      throughBlock: '105', excludeTokenAddresses: [], shardCount: 4, shardIndex: 2,
    }]);
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
      readReceiptRange: async () => { throw new Error('must not read receipts'); },
    };
    const result = await createRobinhoodHolderBackfillExecutor({ repository, reader }).runOnce();

    assert.deepEqual(result, {
      status: 'resyncing', tokenAddress: TOKEN,
      reason: 'holder_backfill_checkpoint_orphaned',
    });
    assert.equal(calls.length, 1);
  });

  it('recovers a transient getLogs deficit from the bounded receipt range', async () => {
    const commits = [];
    const receiptReads = [];
    const repository = {
      getNextToken: async () => state(),
      markResyncing: async () => { throw new Error('must not resync'); },
      commitRange: async (range) => {
        commits.push(range);
        if (commits.length === 1) return {
          status: 'drift-suspected', tokenAddress: TOKEN,
          reason: 'holder_negative_balance', fingerprint: 'getlogs-deficit', failedBlock: '104',
        };
        return {
          status: 'committed', tokenAddress: TOKEN, holderCount: '4',
          backfillNextBlock: '105', liveThroughBlock: '104', liveThroughHash: HASH, version: 3,
        };
      },
    };
    const reader = {
      getSafeHead: async () => ({ safeHead: '105' }),
      matchesCheckpoint: async () => true,
      readRange: async (range) => ({
        ...range, checkpoint: { number: '105', hash: HASH }, transfers: [],
      }),
      readReceiptRange: async (range) => {
        receiptReads.push(range);
        return { ...range, checkpoint: { number: '104', hash: HASH }, transfers: [] };
      },
    };

    const result = await createRobinhoodHolderBackfillExecutor({ repository, reader }).runOnce();

    assert.equal(result.status, 'committed');
    assert.equal(result.recoverySource, 'receipts');
    assert.deepEqual(receiptReads, [{
      tokenAddress: TOKEN, fromBlock: '103', toBlock: '104', batchSize: 25,
    }]);
    assert.equal(commits.length, 2);
    assert.equal(commits[1].toBlock, '104');
  });

  it('narrows a wide deficit to the receipt-safe range instead of entering cooldown', async () => {
    const commits = [];
    const reads = [];
    const repository = {
      getNextToken: async () => state(),
      markResyncing: async () => { throw new Error('must not resync'); },
      commitRange: async (range) => {
        commits.push(range);
        if (commits.length === 1) return {
          status: 'drift-suspected', tokenAddress: TOKEN,
          reason: 'holder_negative_balance', fingerprint: 'wide-deficit', failedBlock: '400',
        };
        return {
          status: 'committed', tokenAddress: TOKEN, holderCount: '4',
          backfillNextBlock: '353', liveThroughBlock: '352', liveThroughHash: HASH,
          version: 3,
        };
      },
    };
    const reader = {
      getSafeHead: async () => ({ safeHead: '500' }),
      matchesCheckpoint: async () => true,
      readRange: async (range) => {
        reads.push(range);
        return { ...range, checkpoint: { number: range.toBlock, hash: HASH }, transfers: [] };
      },
      readReceiptRange: async () => { throw new Error('must not read oversized receipt range'); },
    };
    const executor = createRobinhoodHolderBackfillExecutor({
      repository, reader, receiptBlockLimit: 250,
    });

    const result = await executor.runOnce({ rangeSize: 500 });

    assert.equal(result.status, 'committed');
    assert.equal(result.recoverySource, 'adaptive-range');
    assert.equal(result.originalFailedBlock, '400');
    assert.deepEqual(reads, [
      { tokenAddress: TOKEN, fromBlock: '103', toBlock: '500' },
      { tokenAddress: TOKEN, fromBlock: '103', toBlock: '352' },
    ]);
    assert.equal(commits.length, 2);
  });

  it('requires three identical receipt deficits before isolating drift', async () => {
    const commits = [];
    const selections = [];
    let nowMs = Date.parse('2026-08-11T00:00:00.000Z');
    const repository = {
      getNextToken: async (input) => {
        selections.push(input);
        return input.excludeTokenAddresses.includes(TOKEN) ? null : state();
      },
      markResyncing: async () => { throw new Error('must not resync'); },
      commitRange: async (range) => {
        commits.push(range);
        return range.confirmDrift
          ? { status: 'drifted', tokenAddress: TOKEN, reason: 'holder_negative_balance' }
          : { status: 'drift-suspected', tokenAddress: TOKEN,
            reason: 'holder_negative_balance', fingerprint: 'same-deficit', failedBlock: '105' };
      },
    };
    const reader = {
      getSafeHead: async () => ({ safeHead: '105' }),
      matchesCheckpoint: async () => true,
      readRange: async (range) => ({
        ...range, checkpoint: { number: '105', hash: HASH }, transfers: [],
      }),
      readReceiptRange: async (range) => ({
        ...range, checkpoint: { number: '105', hash: HASH }, transfers: [],
      }),
    };
    const executor = createRobinhoodHolderBackfillExecutor({
      repository, reader, now: () => nowMs, driftRecheckMs: 60_000,
    });

    const first = await executor.runOnce();
    nowMs += 1000;
    const waiting = await executor.runOnce();
    nowMs += 59_000;
    const second = await executor.runOnce();
    nowMs += 60_000;
    const third = await executor.runOnce();

    assert.equal(first.status, 'drift-suspected');
    assert.equal(first.observations, 1);
    assert.equal(waiting.status, 'idle');
    assert.equal(second.observations, 2);
    assert.equal(third.status, 'drifted');
    assert.equal(third.observations, 3);
    assert.equal(commits.length, 7);
    assert.equal(commits.filter(({ confirmDrift }) => confirmDrift === true).length, 1);
    assert.deepEqual(selections.map(({ excludeTokenAddresses }) => excludeTokenAddresses), [
      [], [TOKEN], [], [],
    ]);
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
