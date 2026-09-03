const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  runReconstruction,
  __private,
} = require('../src/utils/reconstruct-robinhood-v3-archive');

const POOL = `0x${'b'.repeat(40)}`;

function options(overrides = {}) {
  return {
    mode: 'write', rpcUrl: 'http://127.0.0.1:18547',
    fromBlock: '100', toBlock: '100', rangeSize: 1, minRangeSize: 1,
    batchSize: 500, rpcConcurrency: 8, maxRanges: 0, sleepMs: 0,
    rpcBatchSize: 25, checkpointFile: null,
    ...overrides,
  };
}

function registry() {
  return {
    protocol: 'uniswap-v3', market_key: `robinhood:uniswap-v3:${POOL}`,
    pool_address: POOL, pool_id: null, origin_address: null,
    token_address: `0x${'c'.repeat(40)}`, quote_address: `0x${'d'.repeat(40)}`,
    currency0: `0x${'c'.repeat(40)}`, currency1: `0x${'d'.repeat(40)}`,
    fee: 3000, tick_spacing: 60, metadata: { quoteIndex: 1 },
  };
}

function log(number, index = 1, address = POOL) {
  return {
    address,
    transactionHash: `0x${String(index).padStart(64, '0')}`,
    logIndex: `0x${index.toString(16)}`,
    blockNumber: `0x${number.toString(16)}`,
    blockHash: `0x${'a'.repeat(64)}`,
    transactionIndex: '0x0', topics: [require('../src/services/uniswap-v3-decoder').TOPICS.swap],
    data: '0x', removed: false,
  };
}

describe('Robinhood V3 direct archive reconstruction', () => {
  it('requires an explicit bounded interval and validates throughput controls', () => {
    assert.throws(() => __private.parseArgs([], {}), /from-block is required/);
    assert.deepEqual(__private.parseArgs([
      '--from-block=100', '--to-block=200', '--mode=dry-run',
    ], { ROBINHOOD_V3_REPAIR_RPC_URL: 'http://archive' }), {
      mode: 'dry-run', rpcUrl: 'http://archive', fromBlock: '100', toBlock: '200',
      rangeSize: 500, minRangeSize: 1, batchSize: 500, rpcConcurrency: 8,
      rpcBatchSize: 25, maxRanges: 0, sleepMs: 100, checkpointFile: null,
    });
    assert.throws(() => __private.parseArgs([
      '--from-block=200', '--to-block=100',
    ], {}), /must not precede/);
  });

  it('keeps only registered V3 pool logs and normalizes archive quantities', () => {
    const rows = __private.trackedRows([
      log(100, 2), log(100, 1, `0x${'e'.repeat(40)}`), { ...log(100, 3), removed: true },
    ], __private.poolIndex([registry()]));

    assert.equal(rows.length, 1);
    assert.equal(rows[0].block_number, '100');
    assert.equal(rows[0].log_index, '2');
    assert.equal(rows[0].market_key, registry().market_key);
  });

  it('splits an adaptive eth_getLogs failure and preserves ordered coverage', async () => {
    const calls = [];
    const rpcClient = {
      request: async (_method, [filter]) => {
        calls.push([filter.fromBlock, filter.toBlock]);
        if (filter.fromBlock === '0x64' && filter.toBlock === '0x65') {
          throw Object.assign(new Error('wide'), { code: 'log_range_error' });
        }
        return [];
      },
    };
    const ranges = await __private.fetchRanges(rpcClient, 100n, 101n, 1);

    assert.deepEqual(calls, [['0x64', '0x65'], ['0x64', '0x64'], ['0x65', '0x65']]);
    assert.deepEqual(ranges.map(({ fromBlock, toBlock }) => [fromBlock, toBlock]), [
      [100n, 100n], [101n, 101n],
    ]);
  });

  it('enriches only identities absent from both durable logs and captures', async () => {
    const archiveLogs = [log(100, 1), log(100, 2), log(100, 3)];
    let committed = 0;
    const result = await runReconstruction(options(), {
      repository: {
        listPools: async () => [registry()],
        classify: async (rows) => new Map(rows.map((row) => {
          const state = row.log_index === '1'
            ? { processed: true, captured: false }
            : row.log_index === '2'
              ? { processed: false, captured: true }
              : { processed: false, captured: false };
          return [`${row.transaction_hash}:${row.log_index}`, state];
        })),
        withLock: async (callback) => callback(),
      },
      rpcClient: {
        request: async (method) => (method === 'eth_chainId' ? '0x1237' : archiveLogs),
      },
      enrichBatch: async (rows) => ({
        entries: rows.map(() => ({ observation: { accepted: true } })), failures: [], rpc: {},
      }),
      persistence: {
        commitHeadProcessingBatch: async ({ entries }) => {
          committed += entries.length;
          return { insertedLogs: entries.length, insertedObservations: entries.length };
        },
      },
    });

    assert.equal(committed, 1);
    assert.deepEqual(
      [result.archiveSwapLogs, result.trackedSwapLogs, result.existingProcessed,
        result.existingCaptures, result.missing, result.repaired, result.progressPct],
      [3, 3, 1, 1, 1, 1, 100]
    );
  });

  it('audits the exact missing cohort in dry-run without persistence or enrichment', async () => {
    let mutated = false;
    const result = await runReconstruction(options({ mode: 'dry-run' }), {
      repository: {
        listPools: async () => [registry()],
        classify: async () => new Map(),
        withLock: async (callback) => callback(),
      },
      rpcClient: {
        request: async (method) => (method === 'eth_chainId' ? '0x1237' : [log(100)]),
      },
      enrichBatch: async () => { mutated = true; },
      persistence: { commitHeadProcessingBatch: async () => { mutated = true; } },
    });

    assert.equal(result.missing, 1);
    assert.equal(result.repaired, 0);
    assert.equal(mutated, false);
  });

  it('bisects RPC -32000 batches and isolates only irreducible identities', async () => {
    const rows = [log(100, 1), log(100, 2), log(100, 3)].map((entry) => ({
      transaction_hash: entry.transactionHash,
      log_index: BigInt(entry.logIndex).toString(),
    }));
    const calls = [];
    const built = await __private.enrichResilient(rows, async (batch) => {
      calls.push(batch.length);
      if (batch.length > 1 || batch[0].log_index === '2') {
        throw Object.assign(new Error('RPC error -32000'), { rpcCode: -32000 });
      }
      return { entries: [{ log: batch[0] }], repairedRows: batch, failures: [], rpc: {} };
    });

    assert.deepEqual(calls, [3, 2, 1, 1, 1]);
    assert.equal(built.entries.length, 2);
    assert.equal(built.failures.length, 1);
    assert.equal(built.failures[0].row.log_index, '2');
    assert.equal(built.rpc.splitRetries, 3);
  });

  it('resumes at the saved next block and preserves cumulative counters', async () => {
    const saved = {
      version: 1, mode: 'write', fromBlock: '100', toBlock: '101', nextBlock: '101',
      summary: {
        scannedBlocks: 1, archiveSwapLogs: 1, trackedSwapLogs: 1,
        existingProcessed: 0, existingCaptures: 0, missing: 1,
        repaired: 1, accepted: 1, rejected: 0, failed: 0, ranges: 1,
      },
    };
    const requested = [];
    const checkpoints = [];
    const result = await runReconstruction(options({ toBlock: '101' }), {
      checkpoint: {
        load: async () => saved,
        save: async (checkpoint) => checkpoints.push(checkpoint),
      },
      repository: {
        listPools: async () => [registry()],
        classify: async () => new Map(),
        withLock: async (callback) => callback(),
      },
      rpcClient: {
        request: async (method, [filter] = []) => {
          if (method === 'eth_chainId') return '0x1237';
          requested.push(filter.fromBlock);
          return [log(101, 2)];
        },
      },
      enrichBatch: async () => ({
        entries: [{ observation: { accepted: true } }], failures: [], rpc: {},
      }),
      persistence: {
        commitHeadProcessingBatch: async () => ({ insertedLogs: 1 }),
      },
    });

    assert.deepEqual(requested, ['0x65']);
    assert.equal(result.scannedBlocks, 2);
    assert.equal(result.repaired, 2);
    assert.equal(result.ranges, 2);
    assert.equal(result.progressPct, 100);
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].nextBlock, '102');
    assert.equal(checkpoints[0].completed, true);
  });

  it('rejects a checkpoint created for a different interval', () => {
    assert.throws(() => __private.restoreCheckpoint({
      version: 1, mode: 'write', fromBlock: '99', toBlock: '100', nextBlock: '100',
      summary: Object.fromEntries([
        'scannedBlocks', 'archiveSwapLogs', 'trackedSwapLogs', 'existingProcessed',
        'existingCaptures', 'missing', 'repaired', 'accepted', 'rejected', 'failed', 'ranges',
      ].map((key) => [key, 0])),
    }, options()), /fromBlock does not match/);
  });
});
