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

function createRobinhoodV3BalanceSnapshotter(deps = {}, options = {}) {
  if (typeof deps.rpcClient?.request !== 'function') throw new Error('rpcClient.request is required');
  const tracker = options.tracker || v3.createUniswapV3Tracker({
    seedPools: normalizeSeedPools(options.seedPools),
  });

  function decodeTrackedSwaps(capture) {
    const swaps = [];
    const events = [...(capture.events || [])]
      .sort((left, right) => Number(BigInt(left.logIndex) - BigInt(right.logIndex)));
    for (const event of events) {
      const topic0 = String(event.topics?.[0] || '').toLowerCase();
      const address = String(event.address || '').toLowerCase();
      const log = rpcLog(event, capture.block);
      if (address === v3.ROBINHOOD_V3_FACTORY && topic0 === v3.TOPICS.poolCreated) {
        tracker.processLog(log);
      } else if (topic0 === v3.TOPICS.swap && tracker.getPool(address)) {
        swaps.push({ logIndex: event.logIndex, event: tracker.processLog(log) });
      }
    }
    return swaps;
  }

  async function captureBlock(capture, captureOptions = {}) {
    const swaps = decodeTrackedSwaps(capture);
    const pools = new Map(swaps.map(({ event }) => [event.poolAddress, event]));
    if (!pools.size) return { snapshots: [], pools: 0, missedPools: 0 };
    if (captureOptions.readBalances === false) {
      return { snapshots: [], pools: pools.size, missedPools: 0, skippedPools: pools.size };
    }
    const calls = [...pools.values()].flatMap((event) => [
      { target: event.tokenAddress, allowFailure: true, callData: encodeBalanceOf(event.poolAddress) },
      { target: event.quoteAddress, allowFailure: true, callData: encodeBalanceOf(event.poolAddress) },
    ]);
    const blockTag = `0x${BigInt(capture.block.number).toString(16)}`;
    const data = encodeAggregate3(calls);
    const raw = await deps.rpcClient.request('eth_call', [{
      to: MULTICALL3_ADDRESS, data,
    }, blockTag]);
    const results = decodeAggregate3(raw, calls.length);
    const balances = new Map();
    let resultIndex = 0;
    for (const [poolAddress] of pools) {
      try {
        balances.set(poolAddress, {
          tokenBalanceRaw: uintResult(results[resultIndex], 'token'),
          quoteBalanceRaw: uintResult(results[resultIndex + 1], 'quote'),
        });
      } catch (_) {
        balances.set(poolAddress, null);
      }
      resultIndex += 2;
    }
    const snapshots = swaps.flatMap(({ logIndex, event }) => {
      const balance = balances.get(event.poolAddress);
      return balance ? [{
        logIndex,
        poolAddress: event.poolAddress,
        tokenAddress: event.tokenAddress,
        quoteAddress: event.quoteAddress,
        ...balance,
      }] : [];
    });
    return {
      snapshots,
      pools: pools.size,
      missedPools: [...balances.values()].filter((value) => value == null).length,
      skippedPools: 0,
    };
  }

  return Object.freeze({
    captureBlock,
    getTrackedPoolCount: tracker.getTrackedPoolCount,
  });
}

module.exports = {
  createRobinhoodV3BalanceSnapshotter,
  __private: { normalizeSeedPools, uintResult },
};
