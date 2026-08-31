const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  executeBootstrap, runPreflight,
} = require('../src/services/robinhood-wallet-signed-origin-bootstrap');
const { parseArgs } = require('../src/utils/bootstrap-robinhood-wallet-signed-origins');

const TARGET_SECONDS = 1_788_000_000n;
const hash = (number) => `0x${BigInt(number).toString(16).padStart(64, '0')}`;
const hex = (number) => `0x${BigInt(number).toString(16)}`;
const seconds = (number) => number <= 5n
  ? TARGET_SECONDS - ((5n - number) * 10n)
  : TARGET_SECONDS + ((number - 5n) * 17_280n);

function rpc() {
  return { request: async (method, params) => {
    if (method === 'eth_blockNumber') return hex(12);
    if (method === 'eth_syncing') return false;
    if (method === 'eth_getBlockByNumber') {
      const number = BigInt(params[0]);
      return { number: hex(number), hash: hash(number), timestamp: hex(seconds(number)) };
    }
    throw new Error(`unexpected ${method}`);
  } };
}

function activationDatabase() {
  return { query: async () => ({ rows: [{
    activation_at: new Date(Number((TARGET_SECONDS + 86_400n) * 1000n)),
    activation_block: '10', activation_block_hash: hash(10),
  }] }) };
}

function samplingReader(overrides = {}) {
  const calls = [];
  return { calls, assertChain: async () => {}, readBlocks: async (input) => {
    calls.push(input.blockNumbers);
    if (overrides.error) throw overrides.error;
    return { blocks: input.blockNumbers.map((number) => ({ number, hash: hash(number),
      blockTime: new Date(Number(seconds(BigInt(number)) * 1000n)).toISOString(),
      transactionCount: 0 })), origins: [], metrics: { blocksScanned: input.blockNumbers.length,
      transactionsScanned: 0, payloadBytes: input.blockNumbers.length * 100,
      elapsedMs: overrides.elapsedMs ?? 100 } };
  } };
}

describe('Robinhood signed-origin bootstrap', () => {
  it('derives frozen frontiers and approves a bounded read-only sample', async () => {
    const reader = samplingReader();
    const repository = { loadCursor: async () => null };
    const result = await runPreflight({ database: activationDatabase(), repository,
      reader, rpcClient: rpc() }, { confirmations: 1, sampleCount: 3,
      sampleBlocks: 2, maxHours: 5 });
    assert.deepEqual({ origin: result.originBlock, originHash: result.originBlockHash,
      safe: result.safeHead, safeHash: result.safeHeadHash, remaining: result.remainingBlocks,
      approved: result.approved }, { origin: '4', originHash: hash(4), safe: '11',
      safeHash: hash(11), remaining: '8', approved: true });
    assert.deepEqual(reader.calls, [['4', '5'], ['7', '8'], ['10', '11']]);
    assert.equal(result.sampledBlocks, 6);
  });

  it('refuses a resumed cursor whose frozen origin diverges', async () => {
    const repository = { loadCursor: async () => ({ stream: 'seed', originBlock: '3',
      originBlockHash: hash(3), nextBlock: '3', safeHead: '11', safeHeadHash: hash(11),
      checkpointBlock: null, checkpointHash: null, lifecycleState: 'running', version: 0 }) };
    await assert.rejects(runPreflight({ database: activationDatabase(), repository,
      reader: samplingReader(), rpcClient: rpc() }, { confirmations: 1 }),
    (error) => error.code === 'signed_origin_cursor_conflict');
  });

  it('keeps a slow but valid preflight runnable and reports the duration advisory', async () => {
    const result = await runPreflight({ database: activationDatabase(),
      repository: { loadCursor: async () => null },
      reader: samplingReader({ elapsedMs: 3_600_000 }), rpcClient: rpc(),
    }, { confirmations: 1, sampleCount: 1, sampleBlocks: 1, maxHours: 5 });
    assert.equal(result.approved, true);
    assert.equal(result.durationAdvisoryExceeded, true);
    assert.ok(result.projectedHours > 5);
    await assert.rejects(runPreflight({ database: activationDatabase(),
      repository: { loadCursor: async () => null }, reader: samplingReader(), rpcClient: rpc(),
    }, { confirmations: 1, maxHours: 25 }), /at most 24/);
  });

  it('commits every block in order, including empty batches, and resumes atomically', async () => {
    const reader = samplingReader(); const commits = [];
    let cursor = { stream: 'seed', originBlock: '4', originBlockHash: hash(4),
      nextBlock: '4', safeHead: '8', safeHeadHash: hash(8), lifecycleState: 'running', version: 0 };
    const repository = {
      createOrResume: async () => cursor,
      commitBatch: async (input) => {
        commits.push(input);
        const nextBlock = (BigInt(input.blocks.at(-1).number) + 1n).toString();
        cursor = { ...cursor, nextBlock, version: cursor.version + 1,
          lifecycleState: nextBlock === '9' ? 'completed' : 'running' };
        return { cursor, blocksCommitted: input.blocks.length, originsWritten: 0 };
      },
    };
    const result = await executeBootstrap({ repository, reader }, {
      preflight: { approved: true }, batchSize: 2, maxMinutes: 1,
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(commits.map(({ blocks }) => blocks.map(({ number }) => number)),
      [['4', '5'], ['6', '7'], ['8']]);
    assert.deepEqual(commits.map(({ expectedVersion }) => expectedVersion), [0, 1, 2]);
    assert.equal(result.blocksCommitted, 5);
  });

  it('does not commit or advance when a block read fails', async () => {
    let commits = 0;
    const repository = { createOrResume: async () => ({ stream: 'seed', originBlock: '4',
      nextBlock: '4', safeHead: '5', lifecycleState: 'running', version: 0 }),
    commitBatch: async () => { commits += 1; } };
    await assert.rejects(executeBootstrap({ repository,
      reader: samplingReader({ error: new Error('timeout') }) }, {
      preflight: { approved: true }, batchSize: 2, maxMinutes: 1,
    }), /timeout/);
    assert.equal(commits, 0);
  });

  it('keeps the command dry-run by default and rejects unknown arguments', () => {
    assert.deepEqual(parseArgs([]), { apply: false, batchSize: 50, confirmations: 12,
      concurrency: 2, maxHours: 5, maxMinutes: 1440, rpcBatchSize: 20,
      sampleBlocks: 10, sampleCount: 3, timeoutMs: 15_000 });
    assert.throws(() => parseArgs(['--force']), /unexpected argument/);
  });
});
