'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  CANONICAL_CONTRACTS,
  ROBINHOOD_TOKENIZED_ASSETS,
} = require('../src/services/robinhood-market-policy');
const {
  GET_RESERVES_SELECTOR,
  SLOT0_SELECTOR,
  V4_GET_SLOT0_SELECTOR,
  createRobinhoodStockUsdQuoteReader,
} = require('../src/services/robinhood-stock-usd-quote');
const v3 = require('../src/services/uniswap-v3-decoder');
const v4 = require('../src/services/uniswap-v4-decoder');

const STOCK = ROBINHOOD_TOKENIZED_ASSETS.NVDA;
const POOL = `0x${'2'.repeat(40)}`;
const POOL_ID = `0x${'3'.repeat(64)}`;
const STATE_VIEW = `0x${'4'.repeat(40)}`;
const BLOCK_TAG = '0x64';
const Q96 = 1n << 96n;

function word(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

function words(...values) {
  return `0x${values.map(word).join('')}`;
}

function reference(protocol, quoteAddress = CANONICAL_CONTRACTS.USDG) {
  return {
    protocol, marketKey: `robinhood:${protocol}:${POOL}`,
    poolAddress: protocol === 'uniswap-v4' ? null : POOL,
    poolId: protocol === 'uniswap-v4' ? POOL_ID : null,
    originAddress: protocol === 'uniswap-v4' ? STATE_VIEW : POOL,
    tokenAddress: STOCK, quoteAddress,
    currency0: STOCK, currency1: quoteAddress,
  };
}

function dependencies(references, rpcRequest, overrides = {}) {
  return {
    rpcClient: { request: rpcRequest },
    repository: {
      async listStockUsdReferences(input) {
        assert.deepEqual(input, { stockAddress: STOCK, blockNumber: '100' });
        return references;
      },
    },
    metadataReader: {
      async getMetadata(address, options) {
        assert.equal(options.blockTag, BLOCK_TAG);
        return { address, decimals: address === CANONICAL_CONTRACTS.USDG ? 6 : 18 };
      },
    },
    wethQuoteReader: {
      async getSnapshot() { return { priceUsd: '42' }; },
    },
    stateViewAddress: STATE_VIEW,
    ...overrides,
  };
}

describe('Robinhood stock USD quote reader', () => {
  it('prices V2 stock/USDG reserves at the exact requested block', async () => {
    const calls = [];
    const reader = createRobinhoodStockUsdQuoteReader(dependencies(
      [reference('uniswap-v2')], async (method, params, options) => {
        calls.push({ method, params, options });
        return words(2n * (10n ** 18n), 84n * (10n ** 6n), 0);
      }
    ));
    const result = await reader.getSnapshot({ stockAddress: STOCK, blockTag: '100' });
    assert.equal(result.priceUsd, '42');
    assert.equal(result.referenceProtocol, 'uniswap-v2');
    assert.equal(result.source, 'canonical-uniswap-v2-stock-usdg');
    assert.equal(calls[0].params[0].data, GET_RESERVES_SELECTOR);
    assert.equal(calls[0].params[1], BLOCK_TAG);
    assert.equal(calls[0].options.fallbackOnRpcError, true);
  });

  it('supports exact V3 stock/USDG state', async () => {
    const reader = createRobinhoodStockUsdQuoteReader(dependencies(
      [reference('uniswap-v3')], async (_method, params) => {
        assert.equal(params[0].data, SLOT0_SELECTOR);
        return words(Q96, 0, 0, 0);
      }
    ));
    const result = await reader.getSnapshot({ stockAddress: STOCK, blockTag: BLOCK_TAG });
    assert.equal(result.priceUsd, '1000000000000');
    assert.equal(result.referenceProtocol, 'uniswap-v3');
  });

  it('falls back to V4 stock/WETH and composes WETH/USD at the same block', async () => {
    const quoteTags = [];
    const references = [
      reference('uniswap-v3'),
      reference('uniswap-v4', CANONICAL_CONTRACTS.WETH),
    ];
    const reader = createRobinhoodStockUsdQuoteReader(dependencies(
      references,
      async (_method, params) => {
        if (params[0].data === SLOT0_SELECTOR) return '0x';
        assert.equal(params[0].to, STATE_VIEW);
        assert.equal(params[0].data, `${V4_GET_SLOT0_SELECTOR}${POOL_ID.slice(2)}`);
        return words(Q96, 0, 0, 0);
      },
      { wethQuoteReader: { async getSnapshot(options) {
        quoteTags.push(options.blockTag);
        return { priceUsd: '42' };
      } } }
    ));
    const result = await reader.getSnapshot({ stockAddress: STOCK, blockTag: BLOCK_TAG });
    assert.equal(result.priceUsd, '42');
    assert.equal(result.referenceProtocol, 'uniswap-v4');
    assert.equal(result.source, 'canonical-uniswap-v4-stock-weth-usd');
    assert.deepEqual(quoteTags, [BLOCK_TAG]);
  });

  it('deduplicates concurrent reads and caches only a successful stock/block result', async () => {
    let repositoryReads = 0;
    let rpcReads = 0;
    const deps = dependencies([reference('uniswap-v3')], async () => {
      rpcReads += 1;
      return words(Q96);
    });
    const original = deps.repository.listStockUsdReferences;
    deps.repository.listStockUsdReferences = async (input) => {
      repositoryReads += 1;
      return original(input);
    };
    const reader = createRobinhoodStockUsdQuoteReader(deps);
    const concurrent = await Promise.all([
      reader.getSnapshot({ stockAddress: STOCK, blockTag: BLOCK_TAG }),
      reader.getSnapshot({ stockAddress: STOCK, blockTag: BLOCK_TAG }),
    ]);
    assert.equal(concurrent.every((result) => result.cached === false), true);
    assert.equal((await reader.getSnapshot({ stockAddress: STOCK, blockTag: BLOCK_TAG })).cached, true);
    assert.equal(repositoryReads, 1);
    assert.equal(rpcReads, 1);
    assert.equal(reader.getCacheSize(), 1);
  });

  it('fails closed with evidence after exhausting references', async () => {
    const reader = createRobinhoodStockUsdQuoteReader(dependencies(
      [reference('uniswap-v2')], async () => words(0, 0)
    ));
    await assert.rejects(
      reader.getSnapshot({ stockAddress: STOCK, blockTag: BLOCK_TAG }),
      (error) => error.code === 'stock_usd_reference_unavailable'
        && error.details.failures.length === 1
    );
    const missing = createRobinhoodStockUsdQuoteReader(dependencies([], async () => '0x'));
    await assert.rejects(
      missing.getSnapshot({ stockAddress: STOCK, blockTag: BLOCK_TAG }),
      (error) => error.code === 'stock_usd_reference_missing' && error.retryable === false
    );
    await assert.rejects(
      reader.getSnapshot({ stockAddress: `0x${'9'.repeat(40)}`, blockTag: BLOCK_TAG }),
      /official stock token/
    );
  });

  it('makes a covered missing checkpoint deterministic instead of retrying forever', async () => {
    const deps = dependencies([reference('uniswap-v2')], async () => words(0, 0));
    deps.repository.hasStockUsdReferenceCoverage = async () => true;
    const reader = createRobinhoodStockUsdQuoteReader(deps);
    await assert.rejects(
      reader.getSnapshot({ stockAddress: STOCK, blockTag: BLOCK_TAG }),
      (error) => error.code === 'stock_usd_reference_checkpoint_missing'
        && error.retryable === false
    );
  });

  it('falls back to the last canonical direct USDG event when pruned state is unavailable', async () => {
    const deps = dependencies([reference('uniswap-v3')], async () => '0x');
    deps.repository.findStockUsdEventCheckpoint = async (input) => {
      assert.deepEqual(input, { stockAddress: STOCK, blockNumber: '100' });
      return {
        reference: reference('uniswap-v3'),
        log: {
          blockNumber: '98', blockHash: `0x${'5'.repeat(64)}`,
          transactionHash: `0x${'6'.repeat(64)}`, logIndex: '4', address: POOL,
          topics: [v3.TOPICS.swap, `0x${'0'.repeat(64)}`, `0x${'0'.repeat(64)}`],
          data: words(0, 0, Q96, 1, 0),
        },
      };
    };
    deps.metadataReader = { async getMetadata(address) {
      return { address, decimals: address === CANONICAL_CONTRACTS.USDG ? 6 : 18 };
    } };
    const reader = createRobinhoodStockUsdQuoteReader(deps);
    const result = await reader.getSnapshot({ stockAddress: STOCK, blockTag: BLOCK_TAG });
    assert.equal(result.priceUsd, '1000000000000');
    assert.equal(result.source, 'canonical-uniswap-v3-stock-usdg-journal');
    assert.equal(result.blockTag, '0x62');
    assert.equal(result.requestedBlockTag, BLOCK_TAG);
  });

  it('decodes a canonical V4 journal checkpoint without historical RPC state', async () => {
    const deps = dependencies([reference('uniswap-v4')], async () => '0x');
    deps.repository.findStockUsdEventCheckpoint = async () => ({
      reference: reference('uniswap-v4'),
      log: {
        blockNumber: '99', blockHash: `0x${'7'.repeat(64)}`,
        transactionHash: `0x${'8'.repeat(64)}`, logIndex: '5', address: STATE_VIEW,
        topics: [v4.TOPICS.swap, POOL_ID, `0x${'0'.repeat(64)}`],
        data: words(0, 0, Q96, 1, 0, 0),
      },
    });
    deps.metadataReader = { async getMetadata(address) {
      return { address, decimals: address === CANONICAL_CONTRACTS.USDG ? 6 : 18 };
    } };
    const result = await createRobinhoodStockUsdQuoteReader(deps)
      .getSnapshot({ stockAddress: STOCK, blockTag: BLOCK_TAG });
    assert.equal(result.priceUsd, '1000000000000');
    assert.equal(result.source, 'canonical-uniswap-v4-stock-usdg-journal');
    assert.equal(result.blockTag, '0x63');
  });
});
