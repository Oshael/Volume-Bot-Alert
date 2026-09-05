'use strict';

function positiveInteger(value, label, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new RangeError(`${label} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function missingCursor() {
  const error = new Error('liquidity event cursor is missing');
  error.code = 'liquidity_event_cursor_missing';
  return error;
}

function createRobinhoodCanonicalLiquidityScanner(deps = {}, input = {}) {
  if (!deps.source?.readNextRange || !deps.cursorRepository?.loadCursor
    || !deps.poolRepository?.listPoolsForLiquidityEvents
    || !deps.refreshQueue?.commitScannedRange) {
    throw new Error('canonical liquidity scanner dependencies are required');
  }
  const maxBlocks = positiveInteger(input.maxBlocks ?? 1000, 'maxBlocks', 1000);

  async function scanNextRange() {
    const cursor = await deps.cursorRepository.loadCursor();
    if (!cursor) throw missingCursor();
    const range = await deps.source.readNextRange({
      fromBlock: cursor.nextBlock,
      maxBlocks,
    });
    if (range.status === 'caught_up') {
      return Object.freeze({
        status: 'caught_up',
        nextBlock: cursor.nextBlock,
        safeHead: range.safeHead,
        blocks: 0,
        logs: 0,
        affected: 0,
        queued: 0,
      });
    }
    if (range.status !== 'available' || range.toBlock == null || !range.checkpoint) {
      throw new Error(`canonical liquidity range status is invalid: ${range.status}`);
    }
    const pools = await deps.poolRepository.listPoolsForLiquidityEvents(range.logs);
    const nextBlock = (BigInt(range.toBlock) + 1n).toString();
    const committed = await deps.refreshQueue.commitScannedRange({
      fromBlock: cursor.nextBlock,
      nextBlock,
      safeHead: range.safeHead,
      checkpoint: range.checkpoint,
      pools,
    });
    return Object.freeze({
      status: 'scanned',
      fromBlock: cursor.nextBlock,
      toBlock: range.toBlock,
      nextBlock: committed.nextBlock,
      safeHead: range.safeHead,
      blocks: Number(BigInt(nextBlock) - BigInt(cursor.nextBlock)),
      logs: range.logs.length,
      affected: pools.length,
      queued: committed.queued,
    });
  }

  return Object.freeze({ scanNextRange });
}

module.exports = { createRobinhoodCanonicalLiquidityScanner };
