const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const { runAudit, __private } = require('../src/utils/audit-robinhood-v3-stock-pairs');
const { ROBINHOOD_TOKENIZED_ASSETS } = require('../src/services/robinhood-market-policy');
const v3 = require('../src/services/uniswap-v3-decoder');

const STOCK = ROBINHOOD_TOKENIZED_ASSETS.QQQ;
const MEME = `0x${'a'.repeat(40)}`;
const POOL = `0x${'b'.repeat(40)}`;
const REFERENCE_POOL = `0x${'d'.repeat(40)}`;

function options(overrides = {}) {
  return {
    rpcUrl: 'http://archive', fromBlock: '100', toBlock: '100', discoveryFromBlock: '0',
    discoveryRangeSize: 10_000_000, swapRangeSize: 100_000, minRangeSize: 1,
    addressBatchSize: 100, identityBatchSize: 5_000, ...overrides,
  };
}

function pool(overrides = {}) {
  return { poolAddress: POOL, token0: MEME, token1: STOCK, blockNumber: '90', ...overrides };
}

function swap(index) {
  return {
    address: POOL, transactionHash: `0x${String(index).padStart(64, '0')}`,
    logIndex: `0x${index.toString(16)}`, blockNumber: '0x64', removed: false,
  };
}

describe('Robinhood V3 stock-pair archive audit', () => {
  it('requires a bounded interval and exposes conservative defaults', () => {
    assert.throws(() => __private.parseArgs([], {}), /from-block is required/);
    assert.deepEqual(__private.parseArgs([
      '--from-block=100', '--to-block=200',
    ], { ROBINHOOD_V3_REPAIR_RPC_URL: 'http://archive' }), {
      rpcUrl: 'http://archive', fromBlock: '100', toBlock: '200', discoveryFromBlock: '0',
      discoveryRangeSize: 10_000_000, swapRangeSize: 100_000, minRangeSize: 1,
      addressBatchSize: 100, identityBatchSize: 5_000,
      maxRanges: 0, checkpointFile: null, reportFile: null,
    });
    assert.throws(() => __private.parseArgs([
      '--from-block=100', '--to-block=200', '--max-ranges=1',
    ], {}), /checkpoint-file is required/);
    assert.equal(__private.parseArgs([
      '--from-block=100', '--to-block=200', '--checkpoint-file=/tmp/audit.json',
    ], {}).reportFile, '/tmp/audit.json.report.json');
    assert.throws(() => __private.parseArgs([
      '--from-block=100', '--to-block=200', '--checkpoint-file=/tmp/audit.json',
      '--report-file=/tmp/audit.json',
    ], {}), /report-file must differ/);
  });

  it('persists JSON snapshots atomically', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-stock-audit-'));
    const filename = path.join(directory, 'state.json');
    try {
      const store = __private.createJsonStore(filename, 'test state');
      assert.equal(await store.load(), null);
      await store.save({ phase: 'discovery', nextBlock: '100' });
      assert.deepEqual(await store.load(), { phase: 'discovery', nextBlock: '100' });
      assert.deepEqual(await fs.readdir(directory), ['state.json']);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a checkpoint from a different interval', () => {
    const saved = __private.emptyAuditState(options());
    saved.toBlock = '101';
    assert.throws(
      () => __private.restoreAuditState(saved, options()),
      /Checkpoint toBlock does not match/
    );
  });

  it('resumes discovery from the saved range and keeps a partial report', async () => {
    let saved = null;
    const snapshots = [];
    const discoveryStarts = [];
    const checkpoint = {
      load: async () => saved,
      save: async (value) => { saved = JSON.parse(JSON.stringify(value)); },
    };
    const reportStore = {
      save: async (value) => { snapshots.push(JSON.parse(JSON.stringify(value))); },
    };
    const rpcClient = {
      request: async (method, [filter] = []) => {
        if (method === 'eth_chainId') return '0x1237';
        if (filter.topics[0] === v3.TOPICS.poolCreated) {
          discoveryStarts.push(filter.fromBlock);
          return filter.fromBlock === '0x0' ? [{}] : [];
        }
        return [];
      },
    };
    const repository = { listRegistered: async () => [], classify: async () => new Map() };
    const first = await runAudit(options({
      fromBlock: '0', toBlock: '199', discoveryRangeSize: 100,
      swapRangeSize: 100, maxRanges: 1,
    }), { rpcClient, repository, checkpoint, reportStore, decodePoolCreated: () => pool({ blockNumber: '0' }) });

    assert.equal(first.completed, false);
    assert.equal(first.phase, 'discovery');
    assert.equal(first.progress.discovery.nextBlock, '100');
    assert.equal(snapshots.at(-1).partial.stockPools.length, 1);

    const completed = await runAudit(options({
      fromBlock: '0', toBlock: '199', discoveryRangeSize: 100,
      swapRangeSize: 100, maxRanges: 0,
    }), { rpcClient, repository, checkpoint, reportStore, decodePoolCreated: () => pool({ blockNumber: '0' }) });

    assert.deepEqual(discoveryStarts, ['0x0', '0x64']);
    assert.equal(completed.candidatePools, 1);
    assert.equal(saved.phase, 'complete');
    assert.equal(snapshots.at(-1).completed, true);
    assert.equal(snapshots.at(-1).report.candidatePools, 1);
  });

  it('starts at the first candidate creation and activates later pools only when born', async () => {
    const secondPool = `0x${'c'.repeat(40)}`;
    const filters = [];
    await runAudit(options({ fromBlock: '0', toBlock: '299', swapRangeSize: 100 }), {
      rpcClient: {
        request: async (method, [filter] = []) => {
          if (method === 'eth_chainId') return '0x1237';
          if (filter.topics[0] === v3.TOPICS.poolCreated) return [{ id: 1 }, { id: 2 }];
          filters.push(filter);
          return [];
        },
      },
      decodePoolCreated: (log) => pool(log.id === 1
        ? { blockNumber: '150' }
        : { poolAddress: secondPool, blockNumber: '260' }),
      repository: { listRegistered: async () => [], classify: async () => new Map() },
    });

    assert.deepEqual(filters.map((filter) => [
      filter.fromBlock, filter.toBlock, Array.isArray(filter.address) ? filter.address.length : 1,
    ]), [['0x96', '0xf9', 1], ['0xfa', '0x12b', 2]]);
  });

  it('separates reference, stock-stock and meme-stock pools with meme orientation', () => {
    assert.deepEqual(__private.classifyPool(pool()), {
      category: 'meme_stock_candidate', stockSymbol: 'QQQ', stockAddress: STOCK,
      tokenAddress: MEME, quoteAddress: STOCK, quoteIndex: 1,
    });
    assert.deepEqual(
      __private.classifyPool(pool({ token0: STOCK, token1: v3.ROBINHOOD_WETH })),
      {
        category: 'stock_reference', stockSymbol: 'QQQ', stockAddress: STOCK,
        quoteAddress: v3.ROBINHOOD_WETH, quoteRoute: 'via_weth',
      }
    );
    assert.equal(__private.classifyPool(pool({
      token0: STOCK, token1: ROBINHOOD_TOKENIZED_ASSETS.NVDA,
    })).category, 'stock_stock');
  });

  it('counts exact durable states without exposing a write dependency', async () => {
    const logs = [swap(1), swap(2), swap(3)];
    const calls = [];
    const result = await runAudit(options(), {
      rpcClient: {
        request: async (method, [filter] = []) => {
          if (method === 'eth_chainId') return '0x1237';
          calls.push(filter);
          return filter.topics[0] === v3.TOPICS.poolCreated ? [{}] : logs;
        },
      },
      decodePoolCreated: () => pool(),
      repository: {
        listRegistered: async () => [{
          pool_address: POOL, market_key: `robinhood:uniswap-v3:${POOL}`,
          token_address: STOCK, quote_address: v3.ROBINHOOD_USDG, active: true,
        }],
        classify: async (rows) => new Map(rows.map((row) => {
          const index = BigInt(row.logIndex).toString();
          return [`${row.transactionHash}:${index}`, {
            processed: index === '1', captured: index === '2',
          }];
        })),
      },
    });

    assert.equal(calls[0].address, v3.ROBINHOOD_V3_FACTORY);
    assert.deepEqual(
      [result.candidatePools, result.registeredCandidatePools, result.archiveSwapLogs,
        result.existingProcessed, result.existingCaptures, result.missing],
      [1, 1, 3, 1, 1, 1]
    );
    assert.equal(result.candidates[0].tokenAddress, MEME);
    assert.equal(result.candidates[0].stockSymbol, 'QQQ');
    assert.equal(result.candidates[0].registryAssessment.status, 'orientation_mismatch');
    assert.equal(result.registryMismatchCandidatePools, 1);
  });

  it('reports initialized reference routes and per-swap historical quote coverage', async () => {
    const candidateRegistry = {
      pool_address: POOL, token_address: MEME, quote_address: STOCK, active: true,
    };
    const referenceRegistry = {
      pool_address: REFERENCE_POOL, token_address: STOCK,
      quote_address: v3.ROBINHOOD_USDG, active: true,
    };
    const result = await runAudit(options(), {
      rpcClient: {
        request: async (method, [filter] = []) => {
          if (method === 'eth_chainId') return '0x1237';
          if (filter.topics[0] === v3.TOPICS.poolCreated) return [{ id: 'candidate' }, { id: 'reference' }];
          if (filter.topics[0] === v3.TOPICS.initialize) {
            return [{ address: REFERENCE_POOL, blockNumber: '0x5f', removed: false }];
          }
          return [swap(1)];
        },
      },
      decodePoolCreated: (log) => log.id === 'candidate'
        ? pool()
        : pool({
          poolAddress: REFERENCE_POOL, token0: STOCK, token1: v3.ROBINHOOD_USDG,
          tokenAddress: STOCK, quoteAddress: v3.ROBINHOOD_USDG, quoteIndex: 1,
          blockNumber: '80', fee: 500, tickSpacing: 10,
        }),
      repository: {
        listRegistered: async () => [candidateRegistry, referenceRegistry],
        classify: async () => new Map(),
      },
    });

    assert.deepEqual(result.historicalQuoteCoverage, {
      directUsdg: 1, viaWeth: 0, uncovered: 0, covered: 1,
      coveragePct: 100, mode: 'initialized_reference_pool',
    });
    assert.equal(result.registryReadyCandidatePools, 1);
    assert.equal(result.referencePools[0].initializedBlock, '95');
    assert.equal(result.referencePools[0].quoteRoute, 'direct_usdg');
    assert.equal(result.referencePools[0].registryAssessment.status, 'ready');
    assert.equal(result.candidates[0].historicalQuoteCoverage.directUsdg, 1);
    assert.deepEqual(result.candidates[0].backfillReadiness, {
      ready: false, blockers: ['stock_quote_valuation_not_implemented'],
    });
  });

  it('splits provider range errors without skipping either half', async () => {
    const calls = [];
    const leaves = await __private.fetchLogs({
      request: async (_method, [filter]) => {
        calls.push([filter.fromBlock, filter.toBlock]);
        if (filter.fromBlock === '0x64' && filter.toBlock === '0x65') {
          throw Object.assign(new Error('wide'), { rpcCode: -32000 });
        }
        return [];
      },
    }, { topics: [v3.TOPICS.swap] }, 100n, 101n, 1);

    assert.equal(leaves.length, 2);
    assert.deepEqual(calls, [['0x64', '0x65'], ['0x64', '0x64'], ['0x65', '0x65']]);
  });
});
