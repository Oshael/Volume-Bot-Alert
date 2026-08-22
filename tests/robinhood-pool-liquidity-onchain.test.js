const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  GET_RESERVES_SELECTOR,
  LIQUIDITY_SELECTOR,
  SLOT0_SELECTOR,
  V4_GET_LIQUIDITY_SELECTOR,
  V4_GET_SLOT0_SELECTOR,
  createRobinhoodPoolLiquidityOnchainReader,
} = require('../src/services/robinhood-pool-liquidity-onchain');
const { ROBINHOOD_USDG, ROBINHOOD_WETH } = require('../src/services/evm-market-metrics');

const TOKEN = `0x${'1'.repeat(40)}`;
const POOL = `0x${'2'.repeat(40)}`;
const POOL_ID = `0x${'3'.repeat(64)}`;
const STATE_VIEW = `0x${'4'.repeat(40)}`;
const Q96 = 1n << 96n;
const ANCHOR = Object.freeze({
  number: '123', hash: `0x${'a'.repeat(64)}`,
  blockTag: '0x7b', observedAt: '2026-08-22T12:00:00.000Z',
});

function word(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

function words(...values) {
  return `0x${values.map(word).join('')}`;
}

function pool(protocol, overrides = {}) {
  return {
    protocol,
    marketKey: `robinhood:${protocol}:${POOL}`,
    poolAddress: protocol === 'uniswap-v4' ? null : POOL,
    poolId: protocol === 'uniswap-v4' ? POOL_ID : null,
    tokenAddress: TOKEN,
    quoteAddress: ROBINHOOD_USDG,
    currency0: TOKEN,
    currency1: ROBINHOOD_USDG,
    ...overrides,
  };
}

function dependencies(request, overrides = {}) {
  return {
    rpcClient: { request },
    metadataReader: {
      async getMetadata(address, options) {
        assert.equal(options.blockTag, ANCHOR.blockTag);
        return { address, decimals: 6, totalSupplyRaw: '1', usable: true };
      },
      async getBalanceOf(address, holder, options) {
        assert.equal(holder, POOL);
        assert.equal(options.blockTag, ANCHOR.blockTag);
        return { address, holder, balanceRaw: address === TOKEN ? '2000000' : '3000000' };
      },
    },
    quoteReader: { async getSnapshot() { throw new Error('USDG must not read WETH quote'); } },
    v4RangeReader: { async listHistoricalV4LiquidityRanges() { return []; } },
    stateViewAddress: STATE_VIEW,
    ...overrides,
  };
}

describe('Robinhood pool liquidity current-state reader', () => {
  it('anchors a round to one canonical block', async () => {
    const reader = createRobinhoodPoolLiquidityOnchainReader(dependencies(
      async (method, params) => {
        assert.equal(method, 'eth_getBlockByNumber');
        assert.deepEqual(params, ['latest', false]);
        return {
          number: '0x7b', hash: ANCHOR.hash,
          timestamp: `0x${(Date.parse(ANCHOR.observedAt) / 1000).toString(16)}`,
        };
      }
    ));
    assert.deepEqual(await reader.readAnchor(), ANCHOR);
  });

  it('values V2 from current reserves without requiring a swap', async () => {
    const calls = [];
    const reader = createRobinhoodPoolLiquidityOnchainReader(dependencies(
      async (method, params) => {
        calls.push({ method, params });
        assert.equal(params[0].data, GET_RESERVES_SELECTOR);
        assert.equal(params[1], ANCHOR.blockTag);
        return words(2_000_000, 5_000_000, 1);
      }
    ));
    const result = await reader.valuePool(pool('uniswap-v2'), ANCHOR);
    assert.equal(result.liquidityUsd, '10');
    assert.equal(result.status, 'spot_estimate_from_double_quote_reserve');
    assert.equal(result.hash, ANCHOR.hash);
    assert.equal(calls.length, 1);
  });

  it('anchors the WETH/USD quote to the same block as pool state', async () => {
    const quoteTags = [];
    const reader = createRobinhoodPoolLiquidityOnchainReader(dependencies(
      async () => words(2_000_000, 5_000_000, 1),
      { quoteReader: { async getSnapshot(options) {
        quoteTags.push(options.blockTag);
        return { priceUsd: '2', source: 'canonical-test' };
      } } }
    ));
    const result = await reader.valuePool(pool('uniswap-v2', {
      quoteAddress: ROBINHOOD_WETH, currency1: ROBINHOOD_WETH,
    }), ANCHOR);
    assert.equal(result.liquidityUsd, '20');
    assert.deepEqual(quoteTags, [ANCHOR.blockTag]);
  });

  it('values V3 from slot0 plus exact pool balances at the anchor', async () => {
    const reader = createRobinhoodPoolLiquidityOnchainReader(dependencies(
      async (_method, params) => {
        if (params[0].data === SLOT0_SELECTOR) return words(Q96, 0, 0, 0, 0, 0, 0);
        if (params[0].data === LIQUIDITY_SELECTOR) return words(50);
        throw new Error('unexpected V3 call');
      }
    ));
    const result = await reader.valuePool(pool('uniswap-v3'), ANCHOR);
    assert.equal(result.liquidityUsd, '5');
    assert.equal(result.liquidityRaw, '50');
    assert.equal(result.status, 'spot_tvl_from_pool_balances');
  });

  it('values V4 from StateView and materialized ranges before any swap', async () => {
    const calls = [];
    const rangesFor = [];
    const reader = createRobinhoodPoolLiquidityOnchainReader(dependencies(
      async (_method, params) => {
        calls.push(params);
        if (params[0].data.startsWith(V4_GET_SLOT0_SELECTOR)) return words(Q96, 0, 0, 0);
        if (params[0].data.startsWith(V4_GET_LIQUIDITY_SELECTOR)) return words(0);
        throw new Error('unexpected V4 call');
      }, { v4RangeReader: { async listHistoricalV4LiquidityRanges(...args) {
        rangesFor.push(args);
        return [];
      } } }
    ));
    const result = await reader.valuePool(pool('uniswap-v4'), ANCHOR);
    assert.equal(result.liquidityUsd, '0');
    assert.equal(result.status, 'spot_tvl_from_v4_tick_ranges');
    assert.equal(calls.every((params) => (
      params[0].to === STATE_VIEW && params[1] === ANCHOR.blockTag
    )), true);
    assert.deepEqual(rangesFor, [[POOL_ID, '124', '0']]);
  });

  it('fails closed on malformed on-chain state', async () => {
    const reader = createRobinhoodPoolLiquidityOnchainReader(dependencies(
      async (_method, params) => (
        params[0].data === SLOT0_SELECTOR ? '0x' : words(1)
      )
    ));
    await assert.rejects(
      reader.valuePool(pool('uniswap-v3'), ANCHOR), /V3 slot0 is malformed/
    );
  });
});
