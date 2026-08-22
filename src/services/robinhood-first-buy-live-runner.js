function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function exclusiveCheckpointTime(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('source checkpoint time is invalid');
  return new Date(parsed.getTime() + 1).toISOString();
}

function regression(message) {
  const error = new Error(message);
  error.code = 'source_frontier_regressed';
  error.fatal = true;
  return error;
}

function assertDependencies(deps) {
  const valid = deps.sourceCursors?.loadRetentionGate && deps.liveCursor?.loadCursor
    && deps.liveCursor?.initializeFromRun && deps.liveCursor?.advance
    && deps.writer?.materializeRange;
  if (!valid) throw new Error('first-buy LIVE dependencies are invalid');
}

function assertFrontier(cursor, source, sourceThrough) {
  if (cursor.nextTime > sourceThrough) {
    throw regression('first-buy LIVE time frontier is ahead of wallet swaps');
  }
  if (cursor.sourceNextBlock != null
      && BigInt(cursor.sourceNextBlock) > BigInt(source.nextBlock)) {
    throw regression('first-buy LIVE block frontier is ahead of wallet swaps');
  }
}

async function loadCursor(liveCursor, seedRunId) {
  return (await liveCursor.loadCursor()) || liveCursor.initializeFromRun(seedRunId);
}

async function runFirstBuyLiveTick(deps = {}, options = {}) {
  assertDependencies(deps);
  const seedRunId = String(options.seedRunId || '').trim();
  if (!/^\d+$/.test(seedRunId)) throw new Error('seedRunId is required');
  const rangeSeconds = boundedInteger(
    options.rangeSeconds, 300, 60, 86_400, 'rangeSeconds'
  );
  const gate = await deps.sourceCursors.loadRetentionGate();
  if (!gate?.valid || gate.seed?.lifecycleState !== 'complete') {
    const reason = gate?.valid ? 'seed_not_complete' : (gate?.reason || null);
    return Object.freeze({ status: 'awaiting-source', reason });
  }
  const cursor = await loadCursor(deps.liveCursor, seedRunId);
  if (!cursor) return Object.freeze({ status: 'awaiting-seed', seedRunId });
  const sourceThrough = exclusiveCheckpointTime(gate.live.checkpointTimestamp);
  assertFrontier(cursor, gate.live, sourceThrough);
  if (cursor.nextTime === sourceThrough) {
    return Object.freeze({
      status: 'caught-up', nextTime: cursor.nextTime,
      sourceThrough, sourceNextBlock: gate.live.nextBlock,
    });
  }
  const rangeEnd = new Date(Math.min(
    new Date(cursor.nextTime).getTime() + (rangeSeconds * 1000),
    new Date(sourceThrough).getTime()
  )).toISOString();
  const result = await deps.writer.materializeRange({
    rangeStart: cursor.nextTime, rangeEnd,
  });
  const advanced = await deps.liveCursor.advance({
    nextTime: rangeEnd, sourceThrough, sourceNextBlock: gate.live.nextBlock,
    expectedVersion: cursor.version,
  });
  if (!advanced) return Object.freeze({ status: 'cursor-conflict' });
  return Object.freeze({
    status: rangeEnd === sourceThrough ? 'caught-up' : 'advanced',
    nextTime: advanced.nextTime, sourceThrough,
    rowsScanned: result.rowsScanned, factsConsidered: result.factsConsidered,
    factsWritten: result.factsWritten,
  });
}

module.exports = { runFirstBuyLiveTick, __private: { exclusiveCheckpointTime } };
