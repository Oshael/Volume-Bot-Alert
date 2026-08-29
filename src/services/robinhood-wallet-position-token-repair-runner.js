const { randomUUID } = require('node:crypto');
const {
  prepareRobinhoodWalletTransferRange,
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

function assertDependencies(deps) {
  requireMethods(deps.coverage, ['claim', 'commitShadowRange', 'retry'], 'repair coverage');
  requireMethods(deps.positions, [
    'readUnifiedRangeSwaps', 'loadPositions',
  ], 'position repository');
  requireMethods(deps.transactionPositions, ['resolveSwaps'], 'transaction-position resolver');
  requireMethods(deps.tickDeps?.evidence, ['matchesCheckpoint'], 'transfer evidence reader');
}

async function runRobinhoodWalletPositionTokenRepairRange(deps = {}, input = {}) {
  assertDependencies(deps);
  const owner = String(input.owner || `position-token-repair:${process.pid}:${randomUUID()}`);
  const claimed = await deps.coverage.claim({ owner, leaseMs: input.leaseMs });
  if (!claimed) return Object.freeze({ status: 'caught-up' });
  const fromBlock = claimed.nextBlock;
  const candidate = BigInt(fromBlock) + BigInt(maxBlocks(input.maxBlocks)) - 1n;
  const through = BigInt(claimed.sourceThroughBlock);
  const toBlock = (candidate < through ? candidate : through).toString();
  try {
    const prepared = await (deps.prepareRange || prepareRobinhoodWalletTransferRange)(
      deps.tickDeps,
      { tokenAddresses: [claimed.tokenAddress], fromBlock, toBlock,
        commit: true, forceAddressFiltered: true }
    );
    if (prepared.outcome) {
      const error = new Error(prepared.outcome.reason || prepared.outcome.status);
      error.code = 'position_token_repair_source_unavailable';
      throw error;
    }
    const canonical = await deps.tickDeps.evidence.matchesCheckpoint({
      number: prepared.captured.checkpoint.number,
      hash: prepared.captured.checkpoint.hash,
    });
    if (!canonical) {
      const error = new Error('position token repair checkpoint is not canonical');
      error.code = 'position_token_repair_checkpoint_mismatch';
      throw error;
    }
    const swapRows = await deps.positions.readUnifiedRangeSwaps({
      fromBlock, toBlock,
      fromTime: prepared.captured.fromBlockTime,
      toTime: prepared.captured.checkpoint.blockTime,
      tokenAddresses: [claimed.tokenAddress],
    });
    const resolved = await deps.transactionPositions.resolveSwaps(swapRows, { commit: true });
    const transfers = prepared.classified.events;
    const pairs = listTouchedWalletPositions(resolved.swaps, transfers);
    const stored = await deps.positions.loadPositions(SHADOW_VERSION, pairs);
    const projected = buildRobinhoodWalletUnifiedPositionBatch({
      swaps: resolved.swaps, transfers, positions: stored,
    });
    const committed = await deps.coverage.commitShadowRange({
      tokenAddress: claimed.tokenAddress, owner, fromBlock, toBlock,
      positions: projected.positions,
    });
    return Object.freeze({
      status: committed.complete ? 'shadow-complete' : 'projected',
      tokenAddress: claimed.tokenAddress, fromBlock, toBlock,
      positions: committed.positions, ...projected.telemetry,
      transactionPositions: resolved.telemetry,
    });
  } catch (error) {
    const status = await deps.coverage.retry({
      tokenAddress: claimed.tokenAddress, owner, error,
      maxAttempts: input.maxAttempts, retryMs: input.retryMs,
    });
    return Object.freeze({
      status, tokenAddress: claimed.tokenAddress, fromBlock, toBlock,
      error: Object.freeze({
        code: error.code || 'position_token_repair_failed', message: error.message,
      }),
    });
  }
}

module.exports = { runRobinhoodWalletPositionTokenRepairRange };
