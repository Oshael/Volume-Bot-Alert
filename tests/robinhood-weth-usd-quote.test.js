const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  CANONICAL_FEE,
  CANONICAL_FEES,
  GET_POOL_SELECTOR,
  LIQUIDITY_SELECTOR,
  ROBINHOOD_V3_FACTORY,
  SLOT0_SELECTOR,
  SWAP_TOPIC,
  buildGetPoolCall,
  createRobinhoodWethUsdQuoteReader,
  priceFromSqrtPriceX96,
} = require('../src/services/robinhood-weth-usd-quote');
const { formatDecimal } = require('../src/services/evm-market-metrics');

const POOL = '0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca';
const POOL_500 = '0x69bfaf19c9f377bb306a89aed9f6b07e2c1a8d9a';
const POOL_3000 = '0xa9188730fe85be88ad499d7d52b099e800fb0334';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const SQRT_PRICE_X96 = BigInt('0x2c8b314992191f34332c6');
const LIQUIDITY = BigInt('0x2bcacc6296f88a4a');
const CASHCAT_LAUNCH_BLOCK = '0x15b04';
const FEE_100_HISTORY_BLOCK = '0x16fc00';

function word(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

function addressResult(address) {
  return `0x${address.slice(2).padStart(64, '0')}`;
}

function feeFromFactoryCall(data) {
  return Number(BigInt(`0x${String(data).slice(-64)}`));
}

function swapLog(blockNumber, sqrtPriceX96 = SQRT_PRICE_X96, logIndex = 1) {
  return {
    blockNumber,
    logIndex: `0x${logIndex.toString(16)}`,
    topics: [SWAP_TOPIC],
    data: `0x${word(0)}${word(0)}${word(sqrtPriceX96)}${word(LIQUIDITY)}${word(0)}`,
  };
}

function createRpc(overrides = {}) {
  const calls = [];
  const poolsByFee = overrides.poolsByFee || { 100: POOL };
  return {
    calls,
    request: async (method, params, requestOptions) => {
      calls.push({ method, params, requestOptions });
      if (overrides.handler) return overrides.handler(method, params, requestOptions);
      if (method === 'eth_getCode') return '0x6000';
      if (params[0].to === ROBINHOOD_V3_FACTORY) {
        return addressResult(poolsByFee[feeFromFactoryCall(params[0].data)] || ZERO_ADDRESS);
      }
      if (params[0].data === SLOT0_SELECTOR) return `0x${word(SQRT_PRICE_X96)}${word(0)}`;
      if (params[0].data === LIQUIDITY_SELECTOR) return `0x${word(LIQUIDITY)}`;
      throw new Error('unexpected request');
    },
  };
}

describe('Robinhood canonical WETH/USD quote reader', () => {
  it('derives the pool through the official factory instead of hardcoding it', () => {
    const calldata = buildGetPoolCall(3000);

    assert.equal(calldata.slice(0, 10), GET_POOL_SELECTOR);
    assert.equal(calldata.length, 10 + (64 * 3));
    assert.equal(calldata.endsWith(word(3000)), true);
    assert.equal(calldata.includes(POOL.slice(2)), false);
    assert.deepEqual(CANONICAL_FEES, [100, 500, 3000, 10000]);
    assert.equal(buildGetPoolCall().endsWith(word(CANONICAL_FEE)), true);
  });

  it('reads slot0 and exposes an exact WETH/USDG price snapshot', async () => {
    const rpc = createRpc();
    const reader = createRobinhoodWethUsdQuoteReader({ rpcClient: rpc, now: () => 123456 });
    const snapshot = await reader.getSnapshot();

    assert.equal(snapshot.priceUsd, '1804.567604374506');
    assert.equal(snapshot.source, 'canonical-uniswap-v3-weth-usdg-100');
    assert.equal(snapshot.status, 'observed');
    assert.equal(snapshot.confidence, 'medium');
    assert.equal(snapshot.poolAddress, POOL);
    assert.equal(snapshot.fee, 100);
    assert.equal(snapshot.sqrtPriceX96, SQRT_PRICE_X96.toString());
    assert.equal(snapshot.liquidityRaw, LIQUIDITY.toString());
    assert.equal(snapshot.observedAtMs, 123456);
    assert.equal(snapshot.blockTag, 'latest');
    assert.equal(snapshot.sourceBlockTag, 'latest');
    assert.equal(rpc.calls.length, 7);
  });

  it('reads and caches canonical pool state at the requested historical block', async () => {
    const rpc = createRpc();
    const reader = createRobinhoodWethUsdQuoteReader({ rpcClient: rpc });

    const first = await reader.getSnapshot({ blockTag: FEE_100_HISTORY_BLOCK });
    const cached = await reader.getSnapshot({ blockTag: FEE_100_HISTORY_BLOCK });

    assert.equal(first.blockTag, FEE_100_HISTORY_BLOCK);
    assert.equal(first.sourceBlockTag, FEE_100_HISTORY_BLOCK);
    assert.equal(first.cached, false);
    assert.equal(cached.cached, true);
    assert.equal(reader.getCacheSize(), 1);
    const stateCalls = rpc.calls.filter((call) => (
      call.params?.[0]?.data === SLOT0_SELECTOR || call.params?.[0]?.data === LIQUIDITY_SELECTOR
    ));
    assert.ok(stateCalls.every((call) => call.params.at(-1) === FEE_100_HISTORY_BLOCK));
    assert.ok(rpc.calls.every((call) => (
      call.method === 'eth_getLogs'
      || call.requestOptions?.fallbackOnRpcError === true
    )));
  });

  it('uses the fee 3000 pool that existed at the CASHCAT launch block', async () => {
    const rpc = createRpc({ poolsByFee: { 100: POOL, 500: POOL_500, 3000: POOL_3000 } });
    const snapshot = await createRobinhoodWethUsdQuoteReader({ rpcClient: rpc })
      .getSnapshot({ blockTag: CASHCAT_LAUNCH_BLOCK });

    assert.equal(snapshot.fee, 3000);
    assert.equal(snapshot.poolAddress, POOL_3000);
    assert.equal(snapshot.source, 'canonical-uniswap-v3-weth-usdg-3000');
    const historicalStateAddresses = rpc.calls
      .filter((call) => call.params?.at(-1) === CASHCAT_LAUNCH_BLOCK)
      .map((call) => call.params[0].to);
    assert.deepEqual([...new Set(historicalStateAddresses)], [POOL_3000]);
  });

  it('selects the pool with the strongest liquidity at the requested block', async () => {
    const pools = { 100: POOL, 500: POOL_500, 3000: POOL_3000 };
    const liquidityByPool = { [POOL]: 10n, [POOL_500]: 30n, [POOL_3000]: 20n };
    const rpc = createRpc({
      handler: async (method, params) => {
        if (method === 'eth_getCode') return '0x6000';
        if (params[0].to === ROBINHOOD_V3_FACTORY) {
          return addressResult(pools[feeFromFactoryCall(params[0].data)] || ZERO_ADDRESS);
        }
        if (params[0].data === SLOT0_SELECTOR) return `0x${word(SQRT_PRICE_X96)}${word(0)}`;
        if (params[0].data === LIQUIDITY_SELECTOR) {
          return `0x${word(liquidityByPool[params[0].to])}`;
        }
        throw new Error('unexpected request');
      },
    });
    const snapshot = await createRobinhoodWethUsdQuoteReader({ rpcClient: rpc }).getSnapshot();

    assert.equal(snapshot.fee, 500);
    assert.equal(snapshot.poolAddress, POOL_500);
    assert.equal(snapshot.liquidityRaw, '30');
  });

  it('falls back to the latest canonical Swap event when historical state is pruned', async () => {
    const ranges = [];
    const rpc = createRpc({
      handler: async (method, params) => {
        if (method === 'eth_call' && params[1] !== 'latest') throw new Error('missing trie node');
        if (method === 'eth_call' && params[0].to === ROBINHOOD_V3_FACTORY) {
          return addressResult(feeFromFactoryCall(params[0].data) === 100 ? POOL : ZERO_ADDRESS);
        }
        if (method === 'eth_getCode') return '0x6000';
        if (method === 'eth_getLogs') {
          ranges.push([params[0].fromBlock, params[0].toBlock]);
          return params[0].toBlock === FEE_100_HISTORY_BLOCK ? [swapLog('0x16fbf5')] : [];
        }
        throw new Error('unexpected request');
      },
    });
    const reader = createRobinhoodWethUsdQuoteReader({ rpcClient: rpc, eventRangeSize: 1000 });

    const first = await reader.getSnapshot({ blockTag: FEE_100_HISTORY_BLOCK });
    const later = await reader.getSnapshot({ blockTag: '0x16fc10' });

    assert.equal(first.priceUsd, '1804.567604374506');
    assert.equal(first.source, 'canonical-uniswap-v3-weth-usdg-100-swap-event');
    assert.equal(first.sourceBlockTag, '0x16fbf5');
    assert.equal(later.sourceBlockTag, '0x16fbf5');
    assert.deepEqual(ranges, [['0x16fbe9', FEE_100_HISTORY_BLOCK], ['0x16fc01', '0x16fc10']]);
  });

  it('caches an empty event interval instead of rescanning back to deployment', async () => {
    const ranges = [];
    const rpc = createRpc({
      handler: async (method, params) => {
        if (method === 'eth_call' && params[1] !== 'latest') throw new Error('missing trie node');
        if (method === 'eth_call') {
          return addressResult(feeFromFactoryCall(params[0].data) === 100 ? POOL : ZERO_ADDRESS);
        }
        if (method === 'eth_getCode') return '0x6000';
        if (method === 'eth_getLogs') {
          ranges.push([params[0].fromBlock, params[0].toBlock]);
          return [];
        }
        throw new Error('unexpected request');
      },
    });
    const reader = createRobinhoodWethUsdQuoteReader({ rpcClient: rpc });

    await assert.rejects(
      reader.getSnapshot({ blockTag: '0x16fbf0' }),
      /No canonical WETH\/USDG Swap/
    );
    await assert.rejects(reader.getSnapshot({ blockTag: '0x16fbf5' }), /No canonical/);
    assert.deepEqual(ranges, [['0x16fbe9', '0x16fbf0'], ['0x16fbf1', '0x16fbf5']]);
  });

  it('caches only the verified pool identity while refreshing price state', async () => {
    const rpc = createRpc();
    const reader = createRobinhoodWethUsdQuoteReader({ rpcClient: rpc });
    await reader.getSnapshot();
    await reader.getSnapshot();

    assert.equal(rpc.calls.filter((call) => call.params?.[0]?.to === ROBINHOOD_V3_FACTORY).length, 4);
    assert.equal(rpc.calls.filter((call) => call.method === 'eth_getCode').length, 1);
    assert.equal(rpc.calls.filter((call) => call.params?.[0]?.data === SLOT0_SELECTOR).length, 2);
  });

  it('rejects an absent pool or a pool without bytecode', async () => {
    const zeroPoolRpc = createRpc({
      handler: async (method) => method === 'eth_getCode'
        ? '0x'
        : addressResult('0x0000000000000000000000000000000000000000'),
    });
    await assert.rejects(
      createRobinhoodWethUsdQuoteReader({ rpcClient: zeroPoolRpc }).getSnapshot(),
      /not deployed/
    );

    const noCodeRpc = createRpc({
      handler: async (method) => method === 'eth_getCode' ? '0x' : addressResult(POOL),
    });
    await assert.rejects(
      createRobinhoodWethUsdQuoteReader({ rpcClient: noCodeRpc }).getSnapshot(),
      /no bytecode/
    );
  });

  it('fails closed for malformed state and invalid sqrt prices', async () => {
    const rpc = createRpc({
      handler: async (method, params) => {
        if (method === 'eth_getCode') return '0x6000';
        if (params[0].to === ROBINHOOD_V3_FACTORY) {
          return addressResult(feeFromFactoryCall(params[0].data) === 100 ? POOL : ZERO_ADDRESS);
        }
        if (params[0].data === SLOT0_SELECTOR) return '0x12';
        return `0x${word(LIQUIDITY)}`;
      },
    });

    await assert.rejects(
      createRobinhoodWethUsdQuoteReader({ rpcClient: rpc }).getSnapshot(),
      /malformed ABI data/
    );
    assert.throws(() => priceFromSqrtPriceX96(0n), /outside uint160/);
    assert.equal(formatDecimal(priceFromSqrtPriceX96(SQRT_PRICE_X96), 12), '1804.567604374506');
  });
});
