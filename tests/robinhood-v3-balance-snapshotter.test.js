'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const fixture = require('../data/fixtures/robinhood-uniswap-v3.json');
const { MULTICALL3_ADDRESS } = require('../src/services/evm-erc20-metadata');
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

  it('omits a pool when either balance subcall fails', async () => {
    const rpcClient = { request: async () => aggregateResult([
      { success: true, returnData: `0x${word(123n)}` },
      { success: false, returnData: '0x' },
    ]) };
    const snapshotter = createRobinhoodV3BalanceSnapshotter({ rpcClient });
    const result = await snapshotter.captureBlock(capture([
      event(fixture.poolCreated), event(fixture.swap),
    ]));

    assert.deepEqual(result.snapshots, []);
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

    assert.deepEqual(result.snapshots, []);
    assert.equal(result.skippedPools, 1);
    assert.equal(snapshotter.getTrackedPoolCount(), 1);
    assert.equal(rpcCalls, 0);
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
