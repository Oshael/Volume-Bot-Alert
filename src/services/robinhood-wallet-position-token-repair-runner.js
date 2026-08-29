const { randomUUID } = require('node:crypto');
const {
  prepareRobinhoodWalletTransferRanges,
} = require('./robinhood-wallet-transfer-backfill-tick');
const {
  buildRobinhoodWalletUnifiedPositionBatch,
  listTouchedWalletPositions,
} = require('./robinhood-wallet-unified-position-batch');
const {
  SHADOW_VERSION,
} = require('../models/robinhood-wallet-position-token-repair');

function requireMethods(value, names, label) {
  if (!names.every((name) => typeof value?.[name] === 'function')) {
    throw new TypeError(`${label} is required`);
  }
}

function maxBlocks(value) {
  const parsed = Number(value ?? 500);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 5000) {
    throw new Error('maxBlocks must be between 1 and 5000');
  }
  return parsed;
}

function bounded(value, fallback, maximum, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function ranges(fromBlock, toBlock, size) {
  const result = [];
  const through = BigInt(toBlock);
  for (let from = BigInt(fromBlock); from <= through; from += BigInt(size)) {
    const candidate = from + BigInt(size) - 1n;
    result.push({
      fromBlock: from.toString(),
      toBlock: (candidate < through ? candidate : through).toString(),
    });
  }
  return result;
}

function assertDependencies(deps) {
  requireMethods(deps.coverage, ['claimBatch', 'commitShadowBatch', 'retry'], 'repair coverage');
  requireMethods(deps.positions, [
    'readUnifiedRangeSwaps', 'loadPositions',
  ], 'position repository');
  requireMethods(deps.transactionPositions, ['resolveSwaps'], 'transaction-position resolver');
  requireMethods(deps.tickDeps?.evidence, ['matchesCheckpoint'], 'transfer evidence reader');
}

async function runRobinhoodWalletPositionTokenRepairRange(deps = {}, input = {}) {
  assertDependencies(deps);
  const owner = String(input.owner || `position-token-repair:${process.pid}:${randomUUID()}`);
  const size = maxBlocks(input.maxBlocks);
  const concurrency = bounded(input.windowConcurrency, 4, 16, 'windowConcurrency');
  const claimed = await deps.coverage.claimBatch({
    owner, leaseMs: input.leaseMs, maxBlocks: size * concurrency,
    limit: bounded(input.tokenBatchSize, 100, 500, 'tokenBatchSize'),
  });
  if (!claimed.length) return Object.freeze({ status: 'caught-up' });
  const fromBlock = claimed[0].nextBlock;
  const candidate = BigInt(fromBlock) + BigInt(size * concurrency) - 1n;
  const through = claimed.reduce((minimum, item) => (
    BigInt(item.sourceThroughBlock) < minimum ? BigInt(item.sourceThroughBlock) : minimum
  ), BigInt(claimed[0].sourceThroughBlock));
  const toBlock = (candidate < through ? candidate : through).toString();
  try {
    const windows = ranges(fromBlock, toBlock, size);
    const prepared = await (deps.prepareRanges || prepareRobinhoodWalletTransferRanges)(
      deps.tickDeps,
      { tokenAddresses: claimed.map(({ tokenAddress }) => tokenAddress), ranges: windows,
        commit: true, forceAddressFiltered: true }
    );
    if (prepared.outcome) {
      const error = new Error(prepared.outcome.reason || prepared.outcome.status);
      error.code = 'position_token_repair_source_unavailable';
      throw error;
    }
    const canonical = await Promise.all(prepared.capturedRanges.map(({ checkpoint }) => (
      deps.tickDeps.evidence.matchesCheckpoint({ number: checkpoint.number, hash: checkpoint.hash })
    )));
    if (canonical.some((matches) => !matches)) {
      const error = new Error('position token repair checkpoint is not canonical');
      error.code = 'position_token_repair_checkpoint_mismatch';
      throw error;
    }
    const swapRows = await deps.positions.readUnifiedRangeSwaps({
      fromBlock, toBlock,
      fromTime: prepared.captured.fromBlockTime,
      toTime: prepared.captured.checkpoint.blockTime,
      tokenAddresses: claimed.map(({ tokenAddress }) => tokenAddress),
    });
    const resolved = await deps.transactionPositions.resolveSwaps(swapRows, { commit: true });
    const cursors = new Map(claimed.map((item) => [item.tokenAddress, BigInt(item.nextBlock)]));
    const afterCursor = (event) => BigInt(event.blockNumber ?? event.block_number)
      >= cursors.get(event.tokenAddress ?? event.token_address);
    const swaps = resolved.swaps.filter(afterCursor);
    const transfers = prepared.classified.events.filter(afterCursor);
    const pairs = listTouchedWalletPositions(swaps, transfers);
    const stored = await deps.positions.loadPositions(SHADOW_VERSION, pairs);
    const projected = buildRobinhoodWalletUnifiedPositionBatch({
      swaps, transfers, positions: stored,
    });
    const committed = await deps.coverage.commitShadowBatch({
      tasks: claimed, owner, toBlock, positions: projected.positions,
    });
    return Object.freeze({
      status: 'batch-projected', tokens: claimed.length, fromBlock, toBlock,
      complete: committed.complete, pending: committed.pending, windows: windows.length,
      positions: committed.positions, ...projected.telemetry,
      transactionPositions: resolved.telemetry,
    });
  } catch (error) {
    const retried = [];
    for (const item of claimed) retried.push({
      tokenAddress: item.tokenAddress,
      status: await deps.coverage.retry({
        tokenAddress: item.tokenAddress, owner, error,
        maxAttempts: input.maxAttempts, retryMs: input.retryMs,
      }),
    });
    return Object.freeze({
      status: 'batch-retried', tokens: claimed.length, fromBlock, toBlock, retried,
      error: Object.freeze({
        code: error.code || 'position_token_repair_failed', message: error.message,
      }),
    });
  }
}

module.exports = { runRobinhoodWalletPositionTokenRepairRange };
