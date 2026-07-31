/**
 * Robinhood wallet-swap seed runner (orchestration).
 *
 * Pure loop that drives one attribution pass:
 *   load cursor -> read next accepted block groups -> attribute -> advance cursor.
 *
 * All I/O is injected (reader, attributor, cursor), so the loop is testable and
 * carries no dependency on any specific RPC client, database module, or worker
 * infrastructure. The standalone entrypoint wires the real dependencies.
 *
 * Progress is only advanced through the cursor's optimistic version, so a
 * thrown error (bad block, reorg guard) leaves the cursor untouched and the
 * batch is safely retried from the same point.
 */
function nextBlockAfter(lastBlock) {
  return (BigInt(lastBlock) + 1n).toString();
}

async function runSeedBatch(deps = {}) {
  const { reader, attributor, cursor, stream = 'seed', maxBlocks } = deps;
  const state = await cursor.loadCursor(stream);
  if (!state) throw new Error(`wallet-swap ${stream} cursor is not initialized`);

  const toBlock = deps.toBlock != null ? String(deps.toBlock) : state.safeHead;
  if (toBlock == null) throw new Error('runSeedBatch needs a toBlock or a cursor safe_head');
  const fromBlock = state.nextBlock;
  if (BigInt(fromBlock) > BigInt(toBlock)) {
    return { done: true, processedBlocks: 0, fromBlock, toBlock };
  }

  const { groups, blockNumbers } = await reader.readAcceptedBlockGroups({ fromBlock, toBlock, maxBlocks });
  if (groups.length === 0) {
    return { done: true, processedBlocks: 0, fromBlock, toBlock };
  }

  const totals = await attributor.attributeGroups(groups);
  const lastBlock = blockNumbers[blockNumbers.length - 1];
  const nextBlock = nextBlockAfter(lastBlock);
  const advanced = await cursor.advanceCursor(stream, { nextBlock, expectedVersion: state.version });
  if (!advanced) {
    return { done: true, conflict: true, processedBlocks: groups.length, fromBlock, lastBlock, totals };
  }

  return {
    done: false,
    processedBlocks: groups.length,
    fromBlock,
    lastBlock,
    nextBlock,
    totals,
    cursorVersion: advanced.version,
  };
}

async function runSeed(deps = {}) {
  const logger = deps.logger || console;
  const maxBatches = deps.maxBatches == null ? Infinity : deps.maxBatches;
  const summary = {
    batches: 0, processedBlocks: 0, attributed: 0, inserted: 0, unresolved: 0, missing: 0, stopped: null,
  };

  for (let index = 0; index < maxBatches; index += 1) {
    const result = await runSeedBatch(deps);
    if (result.totals) {
      summary.batches += 1;
      summary.processedBlocks += result.processedBlocks;
      summary.attributed += result.totals.attributed;
      summary.inserted += result.totals.inserted;
      summary.unresolved += result.totals.unresolved;
      summary.missing += result.totals.missing;
      logger.log?.(
        `[seed] blocks ${result.fromBlock}..${result.lastBlock}: `
        + `inserted ${result.totals.inserted}, unresolved ${result.totals.unresolved}, missing ${result.totals.missing}`
      );
    }
    if (result.conflict) {
      summary.stopped = 'conflict';
      logger.warn?.('[seed] cursor version conflict; another owner is advancing. stopping.');
      break;
    }
    if (result.done) {
      summary.stopped = summary.stopped || 'complete';
      break;
    }
  }
  if (summary.stopped === null) summary.stopped = 'batch-limit';
  return summary;
}

module.exports = { runSeedBatch, runSeed, __private: { nextBlockAfter } };
