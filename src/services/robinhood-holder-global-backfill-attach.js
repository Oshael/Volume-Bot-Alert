const MIN_FINALITY_BLOCKS = 2000;

function createRobinhoodHolderGlobalBackfillAttach(options = {}) {
  const repository = options.repository;
  const reader = options.reader;
  if (typeof repository?.getMaterializationCandidate !== 'function'
      || typeof repository?.getMaterializedHandoffCandidate !== 'function'
      || typeof repository?.materializeBatch !== 'function'
      || typeof repository?.promoteMaterializedBatch !== 'function') {
    throw new TypeError('global holder backfill repository is required');
  }
  if (typeof reader?.getSafeHead !== 'function'
      || typeof reader?.matchesCheckpoint !== 'function') {
    throw new TypeError('holder transfer reader is required');
  }

  async function materializeOnce(input = {}) {
    const finalityBlocks = Number(input.finalityBlocks ?? MIN_FINALITY_BLOCKS);
    if (!Number.isSafeInteger(finalityBlocks) || finalityBlocks < MIN_FINALITY_BLOCKS) {
      throw new Error(`finalityBlocks must be at least ${MIN_FINALITY_BLOCKS}`);
    }
    const run = await repository.getMaterializationCandidate();
    if (!run) return Object.freeze({ status: 'idle' });
    if (run.nextBlock !== run.barrierBlock
        || run.checkpointBlock !== run.barrierCheckpoint?.number
        || run.checkpointHash !== run.barrierCheckpoint?.hash) {
      return Object.freeze({ status: 'waiting-baseline', runId: run.id });
    }
    if (!await reader.matchesCheckpoint(run.barrierCheckpoint)) {
      return Object.freeze({ status: 'checkpoint-diverged', runId: run.id });
    }
    const head = await reader.getSafeHead(finalityBlocks);
    if (BigInt(head.safeHead) < BigInt(run.barrierCheckpoint.number)) {
      return Object.freeze({ status: 'waiting-finality', runId: run.id });
    }
    return repository.materializeBatch({
      runId: run.id, version: run.version, limit: input.limit,
      verifiedCheckpoint: run.barrierCheckpoint, finalizedThrough: head.safeHead,
    });
  }

  async function handoffOnce(input = {}) {
    const finalityBlocks = Number(input.finalityBlocks ?? MIN_FINALITY_BLOCKS);
    if (!Number.isSafeInteger(finalityBlocks) || finalityBlocks < MIN_FINALITY_BLOCKS) {
      throw new Error(`finalityBlocks must be at least ${MIN_FINALITY_BLOCKS}`);
    }
    const run = await repository.getMaterializedHandoffCandidate();
    if (!run) return Object.freeze({ status: 'idle' });
    if (!await reader.matchesCheckpoint(run.barrierCheckpoint)) {
      return Object.freeze({ status: 'checkpoint-diverged', runId: run.id });
    }
    const head = await reader.getSafeHead(finalityBlocks);
    if (BigInt(head.safeHead) < BigInt(run.barrierCheckpoint.number)) {
      return Object.freeze({ status: 'waiting-finality', runId: run.id });
    }
    return repository.promoteMaterializedBatch({
      runId: run.id, version: run.version, limit: input.limit,
      verifiedCheckpoint: run.barrierCheckpoint, finalizedThrough: head.safeHead,
    });
  }

  return Object.freeze({ handoffOnce, materializeOnce });
}

module.exports = { createRobinhoodHolderGlobalBackfillAttach };
