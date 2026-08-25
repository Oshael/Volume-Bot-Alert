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

function tokenBatchSize(value) {
  const parsed = Number(value ?? 500);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new Error('tokenBatchSize must be between 1 and 500');
  }
  return parsed;
}

async function claimTasks(coverage, input, owner) {
  if (typeof coverage.claimBatch === 'function') {
    return coverage.claimBatch({
      owner, leaseMs: input.leaseMs, maxBlocks: blocks(input.maxBlocks),
      limit: tokenBatchSize(input.tokenBatchSize),
    });
  }
  const claimed = await coverage.claim({ owner, leaseMs: input.leaseMs });
  return claimed ? [claimed] : [];
}

async function retryTasks(coverage, claimed, owner, error, maxAttempts) {
  const results = [];
  for (const item of claimed) {
    const status = await coverage.retry({
      tokenAddress: item.tokenAddress, owner, error, maxAttempts,
    });
    results.push({ tokenAddress: item.tokenAddress, status });
  }
  return results;
}

async function commitTasks(coverage, input) {
  const {
    claimed, owner, toBlock, events, maxAttempts,
  } = input;
  if (typeof coverage.commitShadowBatch === 'function') {
    const committed = await coverage.commitShadowBatch({
      owner, tasks: claimed, toBlock, events,
    });
    return Object.freeze({
      completed: committed.complete, projected: committed.pending,
      retried: 0, errors: [],
    });
  }
  const results = [];
  for (const item of claimed) {
    const tokenEvents = events.filter(({ tokenAddress }) => tokenAddress === item.tokenAddress);
    try {
      const committed = await coverage.commitShadowRange({
        tokenAddress: item.tokenAddress, owner,
        fromBlock: item.nextBlock, toBlock, events: tokenEvents,
      });
      results.push({
        tokenAddress: item.tokenAddress,
        status: committed.complete ? 'shadow-complete' : 'projected',
      });
    } catch (error) {
      const status = await coverage.retry({
        tokenAddress: item.tokenAddress, owner, error, maxAttempts,
      });
      results.push({ tokenAddress: item.tokenAddress, status, error: {
        code: error.code || 'token_repair_failed', message: error.message,
      } });
    }
  }
  return Object.freeze({
    completed: results.filter(({ status }) => status === 'shadow-complete').length,
    projected: results.filter(({ status }) => status === 'projected').length,
    retried: results.filter(({ error }) => error).length,
    errors: results.filter(({ error }) => error),
  });
}

async function runRobinhoodWalletTransferTokenRepairRange(deps = {}, input = {}) {
  if (!deps.coverage || !deps.tickDeps) throw new TypeError('token repair dependencies are required');
  const owner = String(input.owner || `token-repair:${process.pid}:${randomUUID()}`);
  const claimed = await claimTasks(deps.coverage, input, owner);
  if (!claimed.length) return Object.freeze({ status: 'caught-up' });
  const fromBlock = claimed[0].nextBlock;
  const candidate = BigInt(fromBlock) + BigInt(blocks(input.maxBlocks)) - 1n;
  const through = claimed.reduce((minimum, item) => {
    const value = BigInt(item.sourceThroughBlock);
    return value < minimum ? value : minimum;
  }, BigInt(claimed[0].sourceThroughBlock));
  const toBlock = (candidate < through ? candidate : through).toString();
  try {
    const prepared = await (deps.prepareRange || prepareRobinhoodWalletTransferRange)(
      deps.tickDeps,
      {
        tokenAddresses: claimed.map(({ tokenAddress }) => tokenAddress),
        fromBlock, toBlock, commit: true, forceAddressFiltered: true,
      }
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
    const cursors = new Map(claimed.map((item) => [item.tokenAddress, BigInt(item.nextBlock)]));
    const scopedEvents = events.filter((event) => (
      cursors.has(event.tokenAddress)
        && BigInt(event.blockNumber) >= cursors.get(event.tokenAddress)
    ));
    const committed = await commitTasks(deps.coverage, {
      claimed, owner, toBlock, events: scopedEvents, maxAttempts: input.maxAttempts,
    });
    return Object.freeze({
      status: 'batch-projected', fromBlock, toBlock, tokens: claimed.length,
      ...committed, events: scopedEvents.length,
    });
  } catch (error) {
    const retried = await retryTasks(
      deps.coverage, claimed, owner, error, input.maxAttempts
    );
    return Object.freeze({
      status: 'batch-retried', fromBlock, toBlock, tokens: claimed.length, retried,
      error: { code: error.code || 'token_repair_failed', message: error.message },
    });
  }
}

module.exports = { runRobinhoodWalletTransferTokenRepairRange };
