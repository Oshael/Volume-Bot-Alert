const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const scope = require('../src/services/robinhood-archive-replay-scope');
const { CANONICAL_CONTRACTS } = require('../src/services/robinhood-market-policy');
const { createRobinhoodBackfillEnrichmentAdapter } = require('../src/services/robinhood-backfill-enrichment-adapter');
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
    rpcBatchSize: 25, enrichmentConcurrency: 2, checkpointFile: null,
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
      mode: 'dry-run', target: 'v3', rpcUrl: 'http://archive', fromBlock: '100', toBlock: '200',
      rangeSize: 500, minRangeSize: 1, batchSize: 500, rpcConcurrency: 8,
      rpcBatchSize: 25, enrichmentConcurrency: 2, maxRanges: 0, sleepMs: 100,
      checkpointFile: null,
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
        commitHeadProcessingBatch: async ({ entries, allowMissingWalletContext }) => {
          assert.equal(allowMissingWalletContext, true);
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

  it('enriches chunks concurrently but persists them sequentially', async () => {
    let activeEnrichments = 0;
    let maximumEnrichments = 0;
    let activeCommits = 0;
    let maximumCommits = 0;
    let releasePair;
    const pairStarted = new Promise((resolve) => { releasePair = resolve; });
    let started = 0;
    const result = await runReconstruction(options({
      batchSize: 1, enrichmentConcurrency: 2,
    }), {
      repository: {
        listPools: async () => [registry()],
        classify: async () => new Map(),
        withLock: async (callback) => callback(),
      },
      rpcClient: {
        request: async (method) => (
          method === 'eth_chainId' ? '0x1237' : [log(100, 1), log(100, 2), log(100, 3)]
        ),
      },
      enrichBatch: async () => {
        started += 1;
        activeEnrichments += 1;
        maximumEnrichments = Math.max(maximumEnrichments, activeEnrichments);
        if (started === 2) releasePair();
        if (started <= 2) await pairStarted;
        activeEnrichments -= 1;
        return { entries: [{ observation: { accepted: true } }], failures: [], rpc: {} };
      },
      persistence: {
        commitHeadProcessingBatch: async () => {
          activeCommits += 1;
          maximumCommits = Math.max(maximumCommits, activeCommits);
          await Promise.resolve();
          activeCommits -= 1;
          return { insertedLogs: 1 };
        },
      },
    });

    assert.equal(maximumEnrichments, 2);
    assert.equal(maximumCommits, 1);
    assert.equal(result.repaired, 3);
    assert.equal(result.lastRange.chunks, 3);
  });
});

function stockRegistry(protocol) {
  const poolId = `0x${'f'.repeat(64)}`;
  return {
    ...registry(), protocol, quote_address: scope.STOCKS[0],
    currency1: scope.STOCKS[0], discovery_block: '1', active: false,
    pool_address: protocol === 'uniswap-v4' ? null : POOL,
    pool_id: protocol === 'uniswap-v4' ? poolId : null,
    origin_address: CANONICAL_CONTRACTS.UNISWAP_V4_POOL_MANAGER,
    market_key: `robinhood:${protocol}:${protocol === 'uniswap-v4' ? poolId : POOL}`,
    metadata: { quoteIndex: 1, quoteKind: 'erc20' },
  };
}

function stockLog(protocol, number = 100, index = 1) {
  const fixture = require(`../data/fixtures/robinhood-${protocol}.json`).swap;
  const pool = stockRegistry(protocol);
  return {
    ...log(number, index, pool.pool_address || pool.origin_address),
    topics: protocol === 'uniswap-v4' ? [fixture.topics[0], pool.pool_id, fixture.topics[2]] : fixture.topics,
    data: fixture.data,
  };
}

function stockDeps(overrides = {}) {
  return {
    repository: {
      listPools: async () => scope.protocols('stock-quote').map(stockRegistry),
      classify: async () => new Map(), withLock: async (callback) => callback(),
    },
    rpcClient: { request: async (method) => {
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_getBlockByNumber') return { number: '0x65', hash: `0x${'a'.repeat(64)}` };
      return [stockLog('uniswap-v2')];
    } },
    enrichBatch: async (rows) => ({ entries: rows.map(() => ({ observation: { accepted: true } })) }),
    persistence: { commitHeadProcessingBatch: async ({ entries }) => ({ insertedObservations: entries.length }) },
    ...overrides,
  };
}

describe('Robinhood Stock V2/V3/V4 archive reconstruction', () => {
  it('uses the archive endpoint and conservative defaults for the isolated Stock target', () => {
    const parsed = __private.parseArgs(['--target=stock-quote', '--from-block=100', '--to-block=101'], {
      ROBINHOOD_ARCHIVE_RPC_URL: 'http://archive', ROBINHOOD_V3_REPAIR_RPC_URL: 'http://legacy',
      ROBINHOOD_V3_RECONSTRUCTION_CHECKPOINT_FILE: '/legacy.json',
    });
    assert.deepEqual([parsed.rpcUrl, parsed.rangeSize, parsed.rpcConcurrency,
      parsed.enrichmentConcurrency, parsed.checkpointFile], ['http://archive', 100, 2, 1, null]);
    assert.throws(() => __private.parseArgs(['--target=all'], {}), /target must/);
  });

  it('matches registered Stock swaps in all protocols, including inactive pools, and rejects unrelated identities', () => {
    const protocols = scope.protocols('stock-quote');
    const pools = protocols.map(stockRegistry);
    const logs = protocols.map((protocol, index) => stockLog(protocol, 100, index + 1));
    const rows = __private.trackedRows([...logs, logs[0],
      { ...logs[2], address: POOL }, { ...logs[2], topics: [logs[2].topics[0], `0x${'e'.repeat(64)}`] },
      { ...logs[0], removed: true }, { ...logs[0], topics: [require('../src/services/uniswap-v2-decoder').TOPICS.sync] },
    ], scope.poolIndex(pools, 'stock-quote', '101'));
    assert.deepEqual(rows.map((row) => row.protocol), protocols);
    const adapter = createRobinhoodBackfillEnrichmentAdapter({ seedPools: pools });
    for (const row of rows) {
      const prepared = adapter.prepareClaim(require('../src/utils/repair-robinhood-v3-pruned-captures').__private.claim(row));
      assert.equal(prepared.context.needsStockQuote, true);
      assert.equal(prepared.context.event.accepted, true);
    }
    for (const invalid of [
      { ...pools[0], token_address: scope.STOCKS[1] },
      { ...pools[0], token_address: CANONICAL_CONTRACTS.WETH },
      { ...pools[0], quote_address: CANONICAL_CONTRACTS.USDG },
      { ...pools[0], discovery_block: '102' },
    ]) assert.equal(scope.poolIndex([invalid], 'stock-quote', '101').size, 0);
    assert.throws(() => __private.trackedRows([logs[0], { ...logs[0], blockHash: `0x${'e'.repeat(64)}` }],
      scope.poolIndex(pools, 'stock-quote')), /conflicting block hashes/);
  });

  it('repairs a processed marker without an observation, but preserves durable observations and captures', async () => {
    const deps = stockDeps();
    deps.rpcClient.request = async (method) => method === 'eth_getLogs'
      ? [1, 2, 3].map((index) => stockLog('uniswap-v2', 100, index))
      : method === 'eth_chainId' ? '0x1237' : { number: '0x65', hash: `0x${'a'.repeat(64)}` };
    deps.repository.classify = async (rows) => new Map(rows.map((row) => [
      `${row.transaction_hash}:${row.log_index}`,
      { processed: true, observed: row.log_index === '2', captured: row.log_index === '3' },
    ]));
    deps.enrichBatch = async (rows, adapterOptions) => {
      assert.equal(typeof adapterOptions.stockQuoteReader.getSnapshot, 'function');
      assert.deepEqual(rows.map((row) => row.log_index), ['1']);
      return { entries: [{ observation: { accepted: true } }] };
    };
    const result = await runReconstruction(options({ target: 'stock-quote', toBlock: '101', rangeSize: 2 }), deps);
    assert.equal(result.repaired, 1);
    assert.equal(result.missing, 1);
  });

  it('stops without writes or a checkpoint when enrichment leaves a gap', async () => {
    let writes = 0;
    for (const built of [{ entries: [] }, { entries: [], failures: [{ error: new Error('archive unavailable') }] }]) {
      const deps = stockDeps({
        enrichBatch: async () => built,
        checkpoint: { load: async () => null, save: async () => { writes += 1; } },
        persistence: { commitHeadProcessingBatch: async () => { writes += 1; } },
      });
      await assert.rejects(runReconstruction(options({ target: 'stock-quote', toBlock: '101' }), deps),
        /range incomplete; checkpoint unchanged/);
      assert.equal(writes, 0);
    }
  });

  it('does not advance the checkpoint after a failed commit or a changed archive branch', async () => {
    for (const failure of ['commit', 'branch']) {
      let saved = false;
      let reads = 0;
      const deps = stockDeps({ checkpoint: { load: async () => null, save: async () => { saved = true; } } });
      if (failure === 'commit') deps.persistence.commitHeadProcessingBatch = async () => { throw new Error('commit failed'); };
      else deps.rpcClient.request = async (method) => {
        if (method === 'eth_chainId') return '0x1237';
        if (method === 'eth_getBlockByNumber') return { number: '0x65', hash: `0x${(++reads === 1 ? 'a' : 'b').repeat(64)}` };
        return [stockLog('uniswap-v2')];
      };
      await assert.rejects(runReconstruction(options({ target: 'stock-quote', toBlock: '101' }), deps),
        failure === 'commit' ? /commit failed/ : /end block changed/);
      assert.equal(saved, false);
    }
  });

  it('pins the scope and branch, honors a canary limit after splitting and resumes only committed ranges', async () => {
    const requested = [];
    let saved;
    const deps = stockDeps({
      checkpoint: { load: async () => saved, save: async (value) => { saved = value; } },
      rpcClient: { request: async (method, [filter] = []) => {
        if (method === 'eth_chainId') return '0x1237';
        if (method === 'eth_getBlockByNumber') return { number: '0x65', hash: `0x${'a'.repeat(64)}` };
        assert.deepEqual(filter.topics, [scope.swapTopics('stock-quote')]);
        requested.push([filter.fromBlock, filter.toBlock]);
        if (filter.fromBlock !== filter.toBlock) throw Object.assign(new Error('wide'), { code: 'log_range_error' });
        return [stockLog('uniswap-v4', Number(BigInt(filter.fromBlock)), Number(BigInt(filter.fromBlock)))];
      } },
    });
    const opts = options({ target: 'stock-quote', toBlock: '101', rangeSize: 2, maxRanges: 1 });
    await runReconstruction(opts, deps);
    assert.equal(saved.nextBlock, '101');
    assert.equal(saved.version, 2);
    const result = await runReconstruction(opts, deps);
    assert.equal(result.repaired, 2);
    assert.equal(saved.completed, true);
    assert.deepEqual(requested.at(-1), ['0x65', '0x65']);
    assert.throws(() => __private.restoreCheckpoint(saved, options({ toBlock: '101' })), /version|target/);
    for (const key of ['poolDigest', 'anchorHash']) {
      assert.throws(() => __private.restoreCheckpoint(saved, { ...opts, ...saved, [key]: 'changed' }), /changed/);
    }
    assert.equal(scope.poolDigest(scope.poolIndex(await deps.repository.listPools(), 'stock-quote')),
      scope.poolDigest(scope.poolIndex((await deps.repository.listPools()).reverse(), 'stock-quote')));
  });

  it('splits a response exactly at the provider cap instead of accepting potentially truncated coverage', async () => {
    const rpcClient = { request: async (_method, [filter]) => {
      const start = Number(BigInt(filter.fromBlock));
      return filter.fromBlock === filter.toBlock ? [log(start)] : [log(100), log(101)];
    } };
    const ranges = await __private.fetchRanges(rpcClient, 100n, 101n, 1, 2, scope.swapTopics('stock-quote'));
    assert.deepEqual(ranges.map(({ fromBlock, toBlock }) => [fromBlock, toBlock]), [[100n, 100n], [101n, 101n]]);
  });
});
