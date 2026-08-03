/**
 * Repository adapter that lets the existing Robinhood continuous runner drive
 * the durable head capture queue instead of the monolithic market persistence.
 *
 * It exposes the same surface the runner expects (loadCursor, listActivePools,
 * listCurrentV4LiquidityRanges, commitMarketRange, commitDiscoveryRange) but:
 *  - cursor and commits go to the independent head capture tables via
 *    appendCaptures (short transaction, no derived work);
 *  - pool-registry reads are delegated to the base persistence repository so
 *    decoder seeding keeps working unchanged.
 *
 * Entries are expected to carry a `capture` payload produced by the head
 * evidence builder ({ protocol, marketKey, evidenceVersion, evidence }).
 * Entries without evidence are skipped; the capture cursor still advances.
 */
const { createRobinhoodHeadCaptureRepository } = require('../models/robinhood-head-capture');
const { createRobinhoodPersistenceRepository } = require('../models/robinhood-persistence');

function mapCursor(cursor, stream) {
  const checkpoint = cursor?.checkpoint || null;
  return {
    stream,
    nextBlock: cursor?.nextBlock,
    safeHead: cursor?.safeHead ?? null,
    checkpoint: checkpoint
      ? {
        number: checkpoint.number,
        hash: checkpoint.hash,
        timestamp: checkpoint.timestampMs ?? checkpoint.timestamp ?? null,
      }
      : null,
  };
}

function mapEntry(entry, stream) {
  const capture = entry.capture;
  return {
    stream,
    protocol: capture.protocol ?? null,
    marketKey: capture.marketKey ?? null,
    evidenceVersion: capture.evidenceVersion,
    evidence: capture.evidence,
    log: entry.log,
  };
}

function createRobinhoodHeadCaptureAdapter(options = {}) {
  const headRepository = options.headRepository
    || createRobinhoodHeadCaptureRepository(options.headOptions);
  const baseRepository = options.baseRepository
    || createRobinhoodPersistenceRepository();

  async function commit(stream, input = {}) {
    const entries = (Array.isArray(input.entries) ? input.entries : [])
      .filter((entry) => entry?.capture?.evidence != null)
      .map((entry) => mapEntry(entry, stream));
    return headRepository.appendCaptures({ entries, cursor: mapCursor(input.cursor, stream) });
  }

  async function loadCursor(stream) {
    const cursor = await headRepository.getCaptureCursor(stream);
    if (!cursor) return null;
    return {
      stream: cursor.stream,
      next_block: cursor.nextBlock,
      checkpoint_block: cursor.checkpointBlock,
      checkpoint_hash: cursor.checkpointHash,
      checkpoint_timestamp: cursor.checkpointTimestamp,
    };
  }

  return Object.freeze({
    loadCursor,
    listActivePools: (...args) => baseRepository.listActivePools(...args),
    listCurrentV4LiquidityRanges: (...args) => baseRepository.listCurrentV4LiquidityRanges(...args),
    commitMarketRange: (input) => commit('market', input),
    commitDiscoveryRange: (input) => commit('discovery', input),
  });
}

module.exports = { createRobinhoodHeadCaptureAdapter };
