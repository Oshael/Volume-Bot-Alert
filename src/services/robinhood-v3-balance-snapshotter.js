'use strict';

const {
  MULTICALL3_ADDRESS,
  decodeAggregate3,
  encodeAggregate3,
  encodeBalanceOf,
} = require('./evm-erc20-metadata');
const v3 = require('./uniswap-v3-decoder');

function seedValue(row, camel, snake) {
  return row?.[camel] ?? row?.[snake] ?? null;
}

function normalizeSeedPools(rows = []) {
  return rows.filter((row) => row.protocol === 'uniswap-v3').map((row) => {
    const metadata = typeof row.metadata === 'string'
      ? JSON.parse(row.metadata) : (row.metadata || {});
    return {
      poolAddress: seedValue(row, 'poolAddress', 'pool_address'),
      marketKey: seedValue(row, 'marketKey', 'market_key'),
      tokenAddress: seedValue(row, 'tokenAddress', 'token_address'),
      quoteAddress: seedValue(row, 'quoteAddress', 'quote_address'),
      quoteIndex: Number(row.quoteIndex ?? metadata.quoteIndex),
      fee: row.fee == null ? null : Number(row.fee),
    };
  });
}

function rpcLog(event, block) {
  return {
    address: event.address,
    topics: event.topics,
    data: event.data,
    blockNumber: block.number.toString(),
    blockHash: block.hash,
    transactionHash: event.transactionHash,
    transactionIndex: event.transactionIndex,
    logIndex: event.logIndex,
  };
}

function uintResult(result, label) {
  const value = String(result?.returnData || '').toLowerCase();
  if (result?.success !== true || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} balanceOf result is unavailable`);
  }
  return BigInt(value).toString();
}

function historicalStateUnavailable(error) {
  return error?.rpcCode === -32000
    && /historical state is not available/i.test(String(error.rpcMessage || ''));
}

function createRobinhoodV3BalanceSnapshotter(deps = {}, options = {}) {
  if (typeof deps.rpcClient?.request !== 'function') throw new Error('rpcClient.request is required');
  let tracker = options.tracker || v3.createUniswapV3Tracker({
    seedPools: normalizeSeedPools(options.seedPools),
  });

  function decodeTrackedSwaps(capture, activeTracker) {
    const swaps = [];
    const events = [...(capture.events || [])]
      .sort((left, right) => Number(BigInt(left.logIndex) - BigInt(right.logIndex)));
    for (const event of events) {
      const topic0 = String(event.topics?.[0] || '').toLowerCase();
      const address = String(event.address || '').toLowerCase();
      const log = rpcLog(event, capture.block);
      if (address === v3.ROBINHOOD_V3_FACTORY && topic0 === v3.TOPICS.poolCreated) {
        activeTracker.processLog(log);
      } else if (topic0 === v3.TOPICS.swap && activeTracker.getPool(address)) {
        swaps.push({ logIndex: event.logIndex, event: activeTracker.processLog(log) });
      }
    }
    return swaps;
  }

  function prepareBlock(capture, captureOptions = {}, activeTracker = tracker) {
    const swaps = decodeTrackedSwaps(capture, activeTracker);
    const pools = new Map(swaps.map(({ event }) => [event.poolAddress, event]));
    if (!pools.size) return async () => ({ snapshots: [], pools: 0, missedPools: 0 });
    function rowsFor(statuses) {
      return swaps.map(({ logIndex, event }) => ({
        logIndex, poolAddress: event.poolAddress,
        tokenAddress: event.tokenAddress, quoteAddress: event.quoteAddress,
        balanceStatus: statuses.get(event.poolAddress).status,
        tokenBalanceRaw: statuses.get(event.poolAddress).tokenBalanceRaw ?? null,
        quoteBalanceRaw: statuses.get(event.poolAddress).quoteBalanceRaw ?? null,
      }));
    }
    if (captureOptions.readBalances === false) {
      const statuses = new Map([...pools.keys()].map((pool) => [pool, { status: 'skipped_window' }]));
      return async () => ({ snapshots: rowsFor(statuses), pools: pools.size,
        missedPools: 0, skippedPools: pools.size });
    }
    const calls = [...pools.values()].flatMap((event) => [
      { target: event.tokenAddress, allowFailure: true, callData: encodeBalanceOf(event.poolAddress) },
      { target: event.quoteAddress, allowFailure: true, callData: encodeBalanceOf(event.poolAddress) },
    ]);
    const blockTag = `0x${BigInt(capture.block.number).toString(16)}`;
    const data = encodeAggregate3(calls);
    return async () => {
      let raw;
      try {
        raw = await deps.rpcClient.request('eth_call', [{
          to: MULTICALL3_ADDRESS, data,
        }, blockTag]);
      } catch (error) {
        if (!historicalStateUnavailable(error)) throw error;
        const statuses = new Map([...pools.keys()].map((pool) => [pool,
          { status: 'historical_unavailable' }]));
        return { snapshots: rowsFor(statuses), pools: pools.size,
          missedPools: pools.size, skippedPools: 0 };
      }
      const results = decodeAggregate3(raw, calls.length);
      const balances = new Map();
      let resultIndex = 0;
      for (const [poolAddress] of pools) {
        try {
          balances.set(poolAddress, { status: 'observed',
            tokenBalanceRaw: uintResult(results[resultIndex], 'token'),
            quoteBalanceRaw: uintResult(results[resultIndex + 1], 'quote'),
          });
        } catch (_) {
          balances.set(poolAddress, { status: 'balance_failed' });
        }
        resultIndex += 2;
      }
      const snapshots = rowsFor(balances);
      return {
        snapshots,
        pools: pools.size,
        missedPools: [...balances.values()].filter((value) => value.status !== 'observed').length,
        skippedPools: 0,
      };
    };
  }

  async function captureBlock(capture, captureOptions = {}) {
    return prepareBlock(capture, captureOptions)();
  }

  function beginBatch() {
    const stagedTracker = v3.createUniswapV3Tracker({ seedPools: tracker.getTrackedPools() });
    return Object.freeze({
      prepareBlock: (capture, captureOptions) => (
        prepareBlock(capture, captureOptions, stagedTracker)
      ),
      commit: () => { tracker = stagedTracker; },
    });
  }

  return Object.freeze({
    captureBlock, beginBatch,
    getTrackedPoolCount: () => tracker.getTrackedPoolCount(),
  });
}

module.exports = {
  createRobinhoodV3BalanceSnapshotter,
  __private: { normalizeSeedPools, uintResult, historicalStateUnavailable },
};
