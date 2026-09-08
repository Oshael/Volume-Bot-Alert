process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const fixture = require('../data/fixtures/robinhood-uniswap-v4.json');
const { ROBINHOOD_TOKENIZED_ASSETS } = require('../src/services/robinhood-market-policy');
const v4 = require('../src/services/uniswap-v4-decoder');
const {
  CONFIRM_FLAG, backfillStockPairs, decodeStockPair, main, parseArgs,
  runGlobalHolderBackfill, __private,
} = require('../src/utils/backfill-robinhood-onboarding');

function stockInitialize() {
  return {
    ...fixture.initialize,
    topics: [
      v4.TOPICS.initialize,
      `0x${'9'.repeat(64)}`,
      fixture.initialize.topics[2],
      `0x${'0'.repeat(24)}${ROBINHOOD_TOKENIZED_ASSETS.AAPL.slice(2)}`,
    ],
  };
}

function options(overrides = {}) {
  return {
    confirm: true,
    rpcUrl: 'http://archive.example',
    fromBlock: '100',
    toBlock: '100',
    rangeSize: 100,
    minRangeSize: 1,
    holderLimit: 50000,
    holderConcurrency: 24,
    globalTimeoutMs: 300 * 60_000,
    timeoutMs: 30000,
    ...overrides,
  };
}

describe('Robinhood combined onboarding backfill', () => {
  it('bounds the global holder scan to exact address-filtered RPC batches', () => {
    const configured = __private.globalOptions(options(), '2026-09-08T00:00:00.000Z');
    assert.equal(configured.prefetch, 16);
    assert.equal(configured.addressFilterLimit, 1000);
    assert.equal(configured.addressShardConcurrency, 1);
  });

  it('orients a meme/stock V4 pool and excludes stock/native reference pools', () => {
    const event = decodeStockPair(stockInitialize(), {
      protocol: 'uniswap-v4', decode: v4.decodeInitialize,
    });
    assert.equal(event.tokenAddress, fixture.expected.currency0);
    assert.equal(event.quoteAddress, ROBINHOOD_TOKENIZED_ASSETS.AAPL);

    const reference = stockInitialize();
    reference.topics[2] = `0x${'0'.repeat(64)}`;
    assert.equal(decodeStockPair(reference, {
      protocol: 'uniswap-v4', decode: v4.decodeInitialize,
    }), null);
  });

  it('scans all discovery protocols and actively upserts stock pairs', async () => {
    const saved = [];
    let activeLogReads = 0;
    let maxActiveLogReads = 0;
    const rpcClient = {
      async request(method, params) {
        if (method === 'eth_chainId') return '0x1237';
        if (method === 'eth_getLogs') {
          activeLogReads += 1;
          maxActiveLogReads = Math.max(maxActiveLogReads, activeLogReads);
          await new Promise((resolve) => setImmediate(resolve));
          activeLogReads -= 1;
          return params[0].address === v4.ROBINHOOD_V4_POOL_MANAGER
            ? [stockInitialize()]
            : [];
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
    const report = await backfillStockPairs(options(), {
      runtime: {
        rpcClient,
        timestamps: { enrich: async (logs) => logs },
        persistence: {
          async upsertRecoveredPools(events) {
            saved.push(...events);
            return { upsertedPools: events.length };
          },
        },
      },
      logger: { log() {} },
    });

    assert.equal(report.stockPairs, 1);
    assert.equal(report.upsertedPools, 1);
    assert.equal(report.protocols['uniswap-v4'].stockPairs, 1);
    assert.equal(saved[0].tracked, true);
    assert.equal(maxActiveLogReads, 3);
  });

  it('runs stock discovery and holder recovery under one confirmation', async () => {
    let holderOptions;
    const report = await main([], {
      options: options({ confirm: false }),
      logger: { log() {} },
      runtime: {
        rpcClient: {
          async request(method) {
            if (method === 'eth_chainId') return '0x1237';
            if (method === 'eth_getLogs') return [];
            throw new Error(`unexpected method ${method}`);
          },
        },
        timestamps: { enrich: async (logs) => logs },
        persistence: {},
      },
      holderMain: async (_argv, deps) => {
        holderOptions = deps.options;
        return { mode: 'read-only', candidates: 12 };
      },
      globalHolderMain: async () => ({
        mode: 'dry-run', preview: { incrementalBackfillActive: false },
      }),
    });

    assert.equal(report.mode, 'read-only');
    assert.equal(report.holders.candidates, 12);
    assert.deepEqual(holderOptions, {
      confirm: false, limit: 50000, concurrency: 24, timeoutMs: 30000,
    });
  });

  it('parallelizes adaptive splits without exceeding the shared RPC limit', async () => {
    let active = 0;
    let maximum = 0;
    const rpcClient = {
      async request(method, params) {
        if (method === 'eth_chainId') return '0x1237';
        if (method !== 'eth_getLogs') throw new Error(`unexpected method ${method}`);
        const [filter] = params;
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        if (BigInt(filter.toBlock) > BigInt(filter.fromBlock)) {
          throw Object.assign(new Error('wide range'), { code: 'log_range_error' });
        }
        return [];
      },
    };
    await backfillStockPairs(options({
      fromBlock: '100', toBlock: '103', rangeSize: 4, stockRpcConcurrency: 4,
    }), {
      runtime: {
        rpcClient,
        timestamps: { enrich: async (logs) => logs },
        persistence: {},
      },
      logger: { log() {} },
    });

    assert.equal(maximum, 4);
  });

  it('reduces RPC concurrency under pressure and recovers after healthy requests', async () => {
    let pressured = true;
    const limiter = __private.createAdaptiveRpcLimiter({
      async request() {
        if (pressured) {
          pressured = false;
          throw Object.assign(new Error('rate limited'), {
            code: 'rate_limited', httpStatus: 429,
          });
        }
        return [];
      },
    }, 4);

    await assert.rejects(limiter.request('eth_getLogs', []), { code: 'rate_limited' });
    assert.deepEqual(limiter.getStatus(), {
      active: 0, queued: 0, limit: 2, maximum: 4, reductions: 1,
    });
    await Promise.all(Array.from({ length: 16 }, () => limiter.request('eth_getLogs', [])));
    assert.equal(limiter.getStatus().limit, 3);
  });

  it('persists protocol cursors and resumes after the last committed range', async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-onboarding-checkpoint-'));
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    const checkpoint = __private.createCheckpointStore(path.join(directory, 'stock.json'));
    const baseOptions = options({
      fromBlock: '100', toBlock: '101', rangeSize: 1, stockRpcConcurrency: 3,
      stockCheckpointFile: path.join(directory, 'stock.json'),
    });
    const runtime = {
      rpcClient: {
        async request(method) {
          if (method === 'eth_chainId') return '0x1237';
          if (method === 'eth_getLogs') return [];
          throw new Error(`unexpected method ${method}`);
        },
      },
      timestamps: { enrich: async (logs) => logs },
      persistence: {},
    };
    await backfillStockPairs(baseOptions, {
      runtime, stockCheckpoint: checkpoint, logger: { log() {} },
    });
    const saved = await checkpoint.load();
    saved.protocols['uniswap-v2'] = {
      ...saved.protocols['uniswap-v2'], nextBlock: '101', completed: false, ranges: 1,
    };
    await checkpoint.save(saved);
    const resumedRanges = [];
    runtime.rpcClient.request = async (method, params) => {
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_getLogs') {
        const [filter] = params;
        resumedRanges.push([filter.address, filter.fromBlock, filter.toBlock]);
        return [];
      }
      throw new Error(`unexpected method ${method}`);
    };

    await backfillStockPairs(baseOptions, {
      runtime, stockCheckpoint: checkpoint, logger: { log() {} },
    });

    assert.equal(resumedRanges.length, 1);
    assert.deepEqual(resumedRanges[0].slice(1), ['0x65', '0x65']);
  });

  it('parses bounded performance controls', () => {
    const parsed = parseArgs([CONFIRM_FLAG], {
      ROBINHOOD_ARCHIVE_RPC_URL: 'http://archive.example',
    });
    assert.equal(parsed.confirm, true);
    assert.equal(parsed.rangeSize, 2_000_000);
    assert.equal(parsed.stockRpcConcurrency, 12);
    assert.throws(() => parseArgs(['--holder-concurrency=65']), /between 1 and 64/);
  });

  it('resumes a frozen global cohort and leaves no duplicate delta behind', async () => {
    const statuses = ['frozen', 'completed'];
    const runtime = {
      lifecycle: {
        async getLatestRun() {
          const status = statuses.shift() || 'completed';
          return { id: '7', status };
        },
      },
    };
    let previews = 0;
    const result = await runGlobalHolderBackfill(options(), {
      globalRuntime: runtime,
      globalDelta: async () => {
        previews += 1;
        return {
          mode: 'dry-run', incrementalBackfillActive: false,
          preview: { candidateTokens: 0 },
        };
      },
      campaignTick: async () => ({ status: 'completed', runId: '7' }),
      logger: { log() {} },
    });

    assert.equal(result.resumedRun, '7');
    assert.equal(result.created, null);
    assert.equal(previews, 2);
  });

  it('fails preflight before any write while the incremental lease is active', async () => {
    let holderRuns = 0;
    await assert.rejects(main([], {
      options: options(),
      globalHolderMain: async () => ({
        mode: 'dry-run', preview: { incrementalBackfillActive: true },
      }),
      holderMain: async () => { holderRuns += 1; },
      logger: { log() {} },
    }), { code: 'holder_global_delta_incremental_active' });
    assert.equal(holderRuns, 0);
  });
});
