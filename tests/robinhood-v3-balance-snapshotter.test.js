'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const fixture = require('../data/fixtures/robinhood-uniswap-v3.json');
const { MULTICALL3_ADDRESS } = require('../src/services/evm-erc20-metadata');
const { createUniswapV3Tracker } = require('../src/services/uniswap-v3-decoder');
const {
  createRobinhoodV3BalanceSnapshotter,
} = require('../src/services/robinhood-v3-balance-snapshotter');

function word(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

function encodeBytes(hex) {
  const raw = hex.slice(2);
  return `${word(raw.length / 2)}${raw.padEnd(Math.ceil(raw.length / 64) * 64, '0')}`;
}

function aggregateResult(results) {
  const tuples = results.map((result) => (
    `${word(result.success ? 1 : 0)}${word(64)}${encodeBytes(result.returnData)}`
  ));
  let offset = results.length * 32;
  const offsets = tuples.map((tuple) => {
    const current = word(offset);
    offset += tuple.length / 2;
    return current;
  }).join('');
  return `0x${word(32)}${word(results.length)}${offsets}${tuples.join('')}`;
}

function event(log, overrides = {}) {
  return {
    address: log.address,
    topics: log.topics,
    data: log.data,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
    ...overrides,
  };
}

function capture(events) {
  return {
    block: { number: BigInt(fixture.swap.blockNumber), hash: fixture.swap.blockHash },
    events,
  };
}

describe('Robinhood V3 balance snapshotter', () => {
  it('freezes all swaps from one pool with one exact-block Multicall', async () => {
    const calls = [];
    const rpcClient = { request: async (method, params) => {
      calls.push({ method, params });
      return aggregateResult([
        { success: true, returnData: `0x${word(123n)}` },
        { success: true, returnData: `0x${word(456n)}` },
      ]);
    } };
    const snapshotter = createRobinhoodV3BalanceSnapshotter({ rpcClient });
    const secondSwap = event(fixture.swap, { logIndex: '0x25' });
    const result = await snapshotter.captureBlock(capture([
      event(fixture.poolCreated), event(fixture.swap), secondSwap,
    ]));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'eth_call');
    assert.equal(calls[0].params[0].to, MULTICALL3_ADDRESS);
    assert.equal(calls[0].params[1], fixture.swap.blockNumber);
    assert.equal(result.pools, 1);
    assert.equal(result.missedPools, 0);
    assert.deepEqual(result.snapshots.map((row) => row.logIndex), ['0x24', '0x25']);
    assert.deepEqual(result.snapshots.map((row) => [
      row.tokenBalanceRaw, row.quoteBalanceRaw,
    ]), [['123', '456'], ['123', '456']]);
  });

  it('tracks pool creation before deferred balance reads from later blocks', async () => {
    const tags = [];
    const snapshotter = createRobinhoodV3BalanceSnapshotter({
      rpcClient: { request: async (_method, params) => {
        tags.push(params[1]);
        return aggregateResult([
          { success: true, returnData: `0x${word(123n)}` },
          { success: true, returnData: `0x${word(456n)}` },
        ]);
      } },
    });
    const createdCapture = capture([event(fixture.poolCreated)]);
    const swappedCapture = capture([event(fixture.swap)]);
    const batch = snapshotter.beginBatch([createdCapture, swappedCapture]);
    const created = batch.prepareBlock(createdCapture);
    const swapped = batch.prepareBlock(swappedCapture);
    assert.deepEqual(tags, []);
    assert.equal(snapshotter.getTrackedPoolCount(), 0);
    const result = await swapped();
    assert.deepEqual(tags, [fixture.swap.blockNumber]);
    assert.equal(result.snapshots[0].poolAddress, fixture.expected.pool);
    assert.deepEqual((await created()).snapshots, []);
    batch.commit();
    assert.equal(snapshotter.getTrackedPoolCount(), 1);
  });

  it('reuses the tracked pools without copying them for a swap-only batch', async () => {
    const tracker = createUniswapV3Tracker({ seedPools: [{
      poolAddress: fixture.expected.pool, tokenAddress: fixture.expected.token1,
      quoteAddress: fixture.expected.token0, quoteIndex: 0, fee: fixture.expected.fee,
    }] });
    const snapshotter = createRobinhoodV3BalanceSnapshotter({
      rpcClient: { request: async () => aggregateResult([
        { success: true, returnData: `0x${word(10n)}` },
        { success: true, returnData: `0x${word(20n)}` },
      ]) },
    }, { tracker: { ...tracker, getTrackedPools: () => {
      throw new Error('swap-only batch copied the tracker');
    } } });
    const input = capture([event(fixture.swap)]);
    const batch = snapshotter.beginBatch([input]);
    const result = await batch.prepareBlock(input)();
    batch.commit();
    assert.equal(result.snapshots[0].tokenBalanceRaw, '10');
    assert.equal(snapshotter.getTrackedPoolCount(), 1);
  });

  it('omits a pool when either balance subcall fails', async () => {
    const rpcClient = { request: async () => aggregateResult([
      { success: true, returnData: `0x${word(123n)}` },
      { success: false, returnData: '0x' },
    ]) };
    const snapshotter = createRobinhoodV3BalanceSnapshotter({ rpcClient });
    const result = await snapshotter.captureBlock(capture([
      event(fixture.poolCreated), event(fixture.swap),
    ]));

    assert.equal(result.snapshots[0].balanceStatus, 'balance_failed');
    assert.equal(result.snapshots[0].tokenBalanceRaw, null);
    assert.equal(result.snapshots[0].quoteBalanceRaw, null);
    assert.equal(result.pools, 1);
    assert.equal(result.missedPools, 1);
  });

  it('learns pools during catch-up without making historical RPC calls', async () => {
    let rpcCalls = 0;
    const snapshotter = createRobinhoodV3BalanceSnapshotter({
      rpcClient: { request: async () => { rpcCalls += 1; } },
    });
    const result = await snapshotter.captureBlock(capture([
      event(fixture.poolCreated), event(fixture.swap),
    ]), { readBalances: false });

    assert.equal(result.snapshots[0].balanceStatus, 'skipped_window');
    assert.equal(result.skippedPools, 1);
    assert.equal(snapshotter.getTrackedPoolCount(), 1);
    assert.equal(rpcCalls, 0);
  });

  it('records only confirmed pruned history and retries other RPC failures', async () => {
    const history = Object.assign(new Error('eth_call RPC error -32000'), {
      rpcCode: -32000, rpcMessage: 'historical state is not available',
    });
    const rpcClient = { request: async () => { throw history; } };
    const snapshotter = createRobinhoodV3BalanceSnapshotter({ rpcClient });
    const input = capture([event(fixture.poolCreated), event(fixture.swap)]);
    const result = await snapshotter.captureBlock(input);
    assert.equal(result.snapshots[0].balanceStatus, 'historical_unavailable');
    assert.equal(result.missedPools, 1);

    rpcClient.request = async () => { throw Object.assign(new Error('execution reverted'), {
      rpcCode: -32000, rpcMessage: 'execution reverted',
    }); };
    await assert.rejects(snapshotter.captureBlock(input), /execution reverted/);
  });

  it('restores tracked pools from persisted registry rows on startup', async () => {
    const rpcClient = { request: async () => aggregateResult([
      { success: true, returnData: `0x${word(10n)}` },
      { success: true, returnData: `0x${word(20n)}` },
    ]) };
    const snapshotter = createRobinhoodV3BalanceSnapshotter({ rpcClient }, { seedPools: [{
      protocol: 'uniswap-v3', pool_address: fixture.expected.pool,
      market_key: `robinhood:uniswap-v3:${fixture.expected.pool}`,
      token_address: fixture.expected.token1, quote_address: fixture.expected.token0,
      fee: fixture.expected.fee, metadata: { quoteIndex: 0 },
    }] });
    const result = await snapshotter.captureBlock(capture([event(fixture.swap)]));

    assert.equal(snapshotter.getTrackedPoolCount(), 1);
    assert.equal(result.snapshots.length, 1);
    assert.equal(result.snapshots[0].tokenBalanceRaw, '10');
  });
});
