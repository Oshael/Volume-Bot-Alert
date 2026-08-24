const { randomUUID } = require('node:crypto');
const { isEdgeEligibleTransfer } = require('./robinhood-wallet-transfer-batch');
const { prepareRobinhoodWalletTransferRange } = require('./robinhood-wallet-transfer-backfill-tick');

function blocks(value) {
  const parsed = Number(value ?? 500);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 5000) {
    throw new Error('maxBlocks must be between 1 and 5000');
  }
  return parsed;
}

async function runRobinhoodWalletTransferTokenRepairRange(deps = {}, input = {}) {
  if (!deps.coverage || !deps.tickDeps) throw new TypeError('token repair dependencies are required');
  const owner = String(input.owner || `token-repair:${process.pid}:${randomUUID()}`);
  const claimed = await deps.coverage.claim({ owner, leaseMs: input.leaseMs });
  if (!claimed) return Object.freeze({ status: 'caught-up' });
  const candidate = BigInt(claimed.nextBlock) + BigInt(blocks(input.maxBlocks)) - 1n;
  const through = BigInt(claimed.sourceThroughBlock);
  const toBlock = (candidate < through ? candidate : through).toString();
  try {
    const prepared = await (deps.prepareRange || prepareRobinhoodWalletTransferRange)(
      deps.tickDeps,
      { tokenAddresses: [claimed.tokenAddress], fromBlock: claimed.nextBlock, toBlock, commit: true }
    );
    if (prepared.outcome) {
      const error = new Error(prepared.outcome.reason || prepared.outcome.status);
      error.code = 'token_repair_source_unavailable';
      throw error;
    }
    const canonical = await deps.tickDeps.evidence.matchesCheckpoint({
      number: prepared.captured.checkpoint.number,
      hash: prepared.captured.checkpoint.hash,
    });
    if (!canonical) {
      const error = new Error('token repair range checkpoint is not canonical');
      error.code = 'token_repair_checkpoint_mismatch';
      throw error;
    }
    const events = prepared.classified.events.filter(isEdgeEligibleTransfer);
    const committed = await deps.coverage.commitShadowRange({
      tokenAddress: claimed.tokenAddress, owner, fromBlock: claimed.nextBlock, toBlock, events,
    });
    return Object.freeze({
      status: committed.complete ? 'shadow-complete' : 'projected',
      tokenAddress: claimed.tokenAddress, fromBlock: claimed.nextBlock, toBlock,
      events: events.length, projected: committed.projected,
    });
  } catch (error) {
    const retryStatus = await deps.coverage.retry({
      tokenAddress: claimed.tokenAddress, owner, error, maxAttempts: input.maxAttempts,
    });
    return Object.freeze({
      status: retryStatus, tokenAddress: claimed.tokenAddress,
      error: { code: error.code || 'token_repair_failed', message: error.message },
    });
  }
}

module.exports = { runRobinhoodWalletTransferTokenRepairRange };
