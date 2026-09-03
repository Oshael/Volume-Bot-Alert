const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { runAudit, __private } = require('../src/utils/audit-robinhood-v3-stock-pairs');
const { ROBINHOOD_TOKENIZED_ASSETS } = require('../src/services/robinhood-market-policy');
const v3 = require('../src/services/uniswap-v3-decoder');

const STOCK = ROBINHOOD_TOKENIZED_ASSETS.QQQ;
const MEME = `0x${'a'.repeat(40)}`;
const POOL = `0x${'b'.repeat(40)}`;

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
    logIndex: `0x${index.toString(16)}`, removed: false,
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
    });
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
    assert.equal(__private.classifyPool(pool({ token0: STOCK, token1: v3.ROBINHOOD_WETH }))
      .category, 'stock_reference');
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
