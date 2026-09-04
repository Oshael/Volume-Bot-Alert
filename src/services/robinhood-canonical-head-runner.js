'use strict';

const { logFromRow } = require('./robinhood-canonical-discovery-capture');

function identity(row) {
  return { domain: row.domain, blockHash: row.block_hash, logIndex: row.log_index };
}
function captureEntry(entry, stream) {
  if (!entry?.capture?.evidence) return null;
  return {
    stream, log: entry.log, protocol: entry.capture.protocol,
    marketKey: entry.capture.marketKey, evidenceVersion: entry.capture.evidenceVersion,
    evidence: entry.capture.evidence,
  };
}
function backoff(attempt, baseMs, maxMs) {
  return Math.min(maxMs, baseMs * (2 ** Math.max(0, Number(attempt) - 1)));
}

function createRobinhoodCanonicalHeadRunner(deps = {}) {
  const { outbox, pipeline, headRepository } = deps;
  if (typeof outbox?.claimNextBlock !== 'function') throw new Error('domain outbox is required');
  if (typeof pipeline?.processDiscoveryRange !== 'function'
      || typeof pipeline?.processMarketRange !== 'function') throw new Error('capture pipeline is required');
  if (typeof headRepository?.appendCaptureEntries !== 'function') {
    throw new Error('head capture repository is required');
  }
  const options = deps.options || {};
  const owner = String(options.owner || `robinhood-canonical-head:${process.pid}`);
  const leaseMs = Number(options.leaseMs) || 60_000;
  const maxBlocks = Number(options.maxBlocks) || 16;
  const maxAttempts = Number(options.maxAttempts) || 5;
  const baseBackoffMs = Number(options.baseBackoffMs) || 1000;
  const maxBackoffMs = Number(options.maxBackoffMs) || 60_000;

  async function runOnce() {
    const reclaimed = await outbox.reclaimExpiredLeases();
    const rows = await outbox.claimNextBlock({ owner, leaseMs, maxBlocks });
    if (!rows.length) return {
      reclaimed, blockNumber: null, throughBlock: null, blocks: 0,
      claimed: 0, inserted: 0, duplicates: 0,
      ignored: 0, completed: 0, blocked: 0, retried: 0,
    };
    const discoveryRows = rows.filter((row) => row.domain === 'discovery');
    const marketRows = rows.filter((row) => row.domain === 'market');
    const blockNumbers = [...new Set(rows.map((row) => String(row.block_number)))];
    const throughBlock = blockNumbers.at(-1);
    try {
      const discovery = await pipeline.processDiscoveryRange(discoveryRows.map(logFromRow));
      const market = await pipeline.processMarketRange(marketRows.map(logFromRow));
      const entries = [
        ...discovery.map((entry) => captureEntry(entry, 'discovery')),
        ...market.map((entry) => captureEntry(entry, 'market')),
      ].filter(Boolean);
      const appended = await headRepository.appendCaptureEntries({ entries });
      const settled = await outbox.settle({
        owner, complete: rows.map(identity), maxAttempts,
      });
      return {
        reclaimed, blockNumber: blockNumbers[0], throughBlock, blocks: blockNumbers.length,
        claimed: rows.length,
        inserted: appended.insertedCaptures, duplicates: appended.duplicateCaptures,
        ignored: rows.length - entries.length, ...settled,
      };
    } catch (error) {
      const retry = rows.map((row) => ({
        ...identity(row), error: { code: error.code || 'capture_failed', message: error.message },
        backoffMs: backoff(row.attempt_count, baseBackoffMs, maxBackoffMs),
      }));
      const settled = await outbox.settle({ owner, retry, maxAttempts });
      return {
        reclaimed, blockNumber: blockNumbers[0], throughBlock, blocks: blockNumbers.length,
        claimed: rows.length,
        inserted: 0, duplicates: 0, ignored: 0, completed: 0, ...settled,
      };
    }
  }

  return Object.freeze({ owner, runOnce });
}

module.exports = { backoff, createRobinhoodCanonicalHeadRunner };
