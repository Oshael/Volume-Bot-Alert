const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodHolderGlobalBackfillScanner,
} = require('../src/services/robinhood-holder-global-backfill-scanner');

const TOKEN = `0x${'1'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;

function runState(nextBlock = '100') {
  return {
    id: '1', status: 'scanning', nextBlock, barrierBlock: null,
  };
}

function range(fromBlock, toBlock, overrides = {}) {
  return {
    fromBlock: String(fromBlock), toBlock: String(toBlock),
    nextBlock: String(BigInt(toBlock) + 1n),
    checkpoint: { number: String(toBlock), hash: HASH },
    transfers: [], telemetry: { requests: 1, splits: 0 }, ...overrides,
  };
}

describe('Robinhood holder global backfill scanner', () => {
  it('prefetches concurrently, commits in order and resumes from the durable cursor', async () => {
    let nextBlock = '100';
    const releases = new Map();
    const commits = [];
    const scanner = createRobinhoodHolderGlobalBackfillScanner({
      lifecycleRepository: {
        getActiveRun: async () => runState(nextBlock),
        loadCohort: async () => [TOKEN],
      },
      commitRepository: {
        async commitRange(input) {
          commits.push(input.fromBlock);
          nextBlock = input.nextBlock;
          return { status: 'committed', ...input, runId: '1' };
        },
        async excludeToken() { throw new Error('unexpected exclusion'); },
      },
      reader: {
        getSafeHead: async () => ({ safeHead: '129' }),
        readReceiptRange: async () => { throw new Error('unexpected receipts'); },
        readGlobalRange: ({ fromBlock, toBlock }) => new Promise((resolve) => {
          releases.set(fromBlock, () => resolve(range(fromBlock, toBlock, {
            telemetry: { requests: 1, splits: fromBlock === '110' ? 1 : 0 },
          })));
        }),
      },
      options: { rangeSize: 10, prefetch: 3 },
    });
    const pending = scanner.runOnce({ throughBlock: 129 });
    await new Promise((resolve) => setImmediate(resolve));
    releases.get('120')();
    releases.get('110')();
    releases.get('100')();
    const result = await pending;

    assert.deepEqual(commits, ['100', '110', '120']);
    assert.equal(result.nextBlock, '130');
    assert.equal(scanner.getStatus().prefetch, 2);
    assert.deepEqual(await scanner.runOnce({ throughBlock: 129 }), {
      status: 'caught-up', runId: '1', nextBlock: '130', throughBlock: '129', prefetch: 2,
    });
  });

  it('excludes malformed cohort logs without advancing the cursor', async () => {
    const exclusions = [];
    const invalid = new Error('bad topics');
    invalid.code = 'holder_transfer_invalid_log';
    invalid.tokenAddress = TOKEN;
    const scanner = createRobinhoodHolderGlobalBackfillScanner({
      lifecycleRepository: {
        getActiveRun: async () => runState('100'), loadCohort: async () => [TOKEN],
      },
      commitRepository: {
        async commitRange() { throw new Error('unexpected commit'); },
        async excludeToken(input) {
          exclusions.push(input);
          return { status: 'excluded', tokenAddress: input.tokenAddress, deletedBalances: 2 };
        },
      },
      reader: {
        getSafeHead: async () => ({ safeHead: '100' }),
        readReceiptRange: async () => { throw new Error('unexpected receipts'); },
        readGlobalRange: async () => { throw invalid; },
      },
      options: { prefetch: 1 },
    });
    const result = await scanner.runOnce({ throughBlock: 100 });
    assert.equal(result.status, 'excluded');
    assert.equal(result.committedRanges, 0);
    assert.deepEqual(exclusions, [{
      runId: '1', tokenAddress: TOKEN, reason: 'malformed_transfer_log',
    }]);
  });

  it('keeps a committed prefix and discards prefetch after a middle failure', async () => {
    let nextBlock = '100';
    const commits = [];
    const scanner = createRobinhoodHolderGlobalBackfillScanner({
      lifecycleRepository: {
        getActiveRun: async () => runState(nextBlock), loadCohort: async () => [TOKEN],
      },
      commitRepository: {
        async commitRange(input) {
          commits.push(input.fromBlock);
          nextBlock = input.nextBlock;
          return { status: 'committed', ...input };
        },
        async excludeToken() { throw new Error('unexpected exclusion'); },
      },
      reader: {
        getSafeHead: async () => ({ safeHead: '129' }),
        readReceiptRange: async () => { throw new Error('unexpected receipts'); },
        readGlobalRange: async ({ fromBlock, toBlock }) => {
          if (fromBlock === '110') throw new Error('middle fetch failed');
          return range(fromBlock, toBlock);
        },
      },
      options: { rangeSize: 10, prefetch: 3 },
    });
    await assert.rejects(scanner.runOnce({ throughBlock: 129 }), /middle fetch failed/);
    assert.deepEqual(commits, ['100']);
    assert.equal(nextBlock, '110');
    assert.equal(scanner.getStatus().totals.discardedPrefetch, 1);
  });

  it('replaces the suspect token prefix with receipt evidence before committing', async () => {
    const receiptTransfer = { tokenAddress: TOKEN, blockNumber: '100' };
    const calls = [];
    const scanner = createRobinhoodHolderGlobalBackfillScanner({
      lifecycleRepository: {
        getActiveRun: async () => runState('100'), loadCohort: async () => [TOKEN],
      },
      commitRepository: {
        async commitRange(input) {
          calls.push(input);
          if (calls.length === 1) {
            const error = new Error('negative');
            error.code = 'holder_negative_balance';
            error.tokenAddress = TOKEN;
            error.failedBlock = '100';
            error.fingerprint = `${HASH}:tx:0`;
            throw error;
          }
          return {
            status: 'committed', fromBlock: input.fromBlock,
            toBlock: input.toBlock, nextBlock: input.nextBlock,
          };
        },
        async excludeToken() { throw new Error('unexpected exclusion'); },
      },
      reader: {
        getSafeHead: async () => ({ safeHead: '100' }),
        readGlobalRange: async () => range(100, 100, {
          transfers: [{ tokenAddress: TOKEN, blockNumber: '100' }],
        }),
        readReceiptRange: async () => ({
          checkpoint: { number: '100', hash: HASH }, transfers: [receiptTransfer],
        }),
      },
      options: { prefetch: 1 },
    });
    const result = await scanner.runOnce({ throughBlock: 100 });
    assert.equal(result.status, 'committed');
    assert.equal(scanner.getStatus().totals.receiptRecoveries, 1);
    assert.deepEqual(calls[1].transfers, [receiptTransfer]);
  });
});
