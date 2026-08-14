const { applyWalletPositionEvent } = require('./robinhood-wallet-position-domain');

const DEFAULT_PROJECTION_VERSION = 'swap_only_v1';

function pairKey(tokenAddress, walletAddress) {
  return `${String(tokenAddress).toLowerCase()}:${String(walletAddress).toLowerCase()}`;
}

function createRobinhoodWalletPositionProjector(options = {}) {
  const repository = options.repository;
  if (!repository) throw new Error('repository is required');

  async function runBatch(input = {}) {
    const projectionVersion = input.projectionVersion || DEFAULT_PROJECTION_VERSION;
    const stream = input.stream || 'seed';
    const activeCursor = input.cursor || await repository.loadCursor(projectionVersion, stream);
    if (!activeCursor) throw new Error('projection cursor is not initialized');
    if (activeCursor.safeHead == null) throw new Error('projection cursor safeHead is required');
    if (activeCursor.nextBlockTime == null) throw new Error('projection cursor nextBlockTime is required');
    if (BigInt(activeCursor.nextBlock) > BigInt(activeCursor.safeHead)) {
      return { dryRun: input.commit !== true, complete: true, swaps: 0, positions: 0 };
    }

    const batch = await repository.readSwapBatch({
      fromBlock: activeCursor.nextBlock,
      fromTime: activeCursor.nextBlockTime,
      toBlock: activeCursor.safeHead,
      maxBlocks: input.maxBlocks,
    });
    const pairs = [...new Map(batch.swaps.map((swap) => {
      const pair = {
        tokenAddress: String(swap.token_address).toLowerCase(),
        walletAddress: String(swap.wallet_address).toLowerCase(),
      };
      return [pairKey(pair.tokenAddress, pair.walletAddress), pair];
    })).values()];
    const stored = await repository.loadPositions(projectionVersion, pairs);
    const positions = new Map(stored.map((position) => [
      pairKey(position.tokenAddress, position.walletAddress), position,
    ]));
    const touched = new Set();
    const countedTransactions = new Set();

    for (const swap of batch.swaps) {
      if (swap.volume_usd == null) throw new Error('swap volume_usd is required');
      const key = pairKey(swap.token_address, swap.wallet_address);
      const sideTx = `${key}:${swap.side}:${String(swap.transaction_hash).toLowerCase()}`;
      const next = applyWalletPositionEvent(positions.get(key) || {}, {
        type: swap.side,
        amountRaw: String(swap.token_amount_raw),
        volumeUsd: String(swap.volume_usd),
        marketCapUsd: swap.market_cap_usd == null ? null : String(swap.market_cap_usd),
        newSideTransaction: !countedTransactions.has(sideTx),
      });
      countedTransactions.add(sideTx);
      positions.set(key, {
        ...next,
        tokenAddress: String(swap.token_address).toLowerCase(),
        walletAddress: String(swap.wallet_address).toLowerCase(),
        throughBlock: String(swap.block_number),
        throughLogIndex: String(swap.action_index),
      });
      touched.add(key);
    }

    const changedPositions = [...touched].map((key) => positions.get(key));
    const summary = {
      dryRun: input.commit !== true,
      complete: BigInt(batch.nextBlock) > BigInt(activeCursor.safeHead),
      fromBlock: activeCursor.nextBlock,
      nextBlock: batch.nextBlock,
      swaps: batch.swaps.length,
      positions: changedPositions.length,
      missingMarketCap: batch.swaps.filter((swap) => swap.market_cap_usd == null).length,
    };
    if (input.commit !== true) return summary;
    const persisted = await repository.commitBatch({
      projectionVersion, stream, expectedVersion: activeCursor.version,
      nextBlock: batch.nextBlock, nextBlockTime: batch.nextBlockTime,
      safeHead: activeCursor.safeHead, positions: changedPositions,
    });
    return { ...summary, persisted };
  }

  return { runBatch };
}

module.exports = { DEFAULT_PROJECTION_VERSION, createRobinhoodWalletPositionProjector };
