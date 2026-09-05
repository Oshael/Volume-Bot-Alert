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
function frontierOf(rows, throughBlock) {
  const row = rows.findLast((candidate) => String(candidate.block_number) === throughBlock);
  return {
    nextBlock: (BigInt(throughBlock) + 1n).toString(),
    safeHead: throughBlock,
    checkpoint: {
      number: throughBlock, hash: row.block_hash, timestamp: row.block_timestamp,
    },
  };
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
  const now = deps.now || Date.now;

  async function measured(timing, key, work) {
    const startedAt = now();
    try {
      return await work();
    } finally {
      timing[key] = Math.max(0, now() - startedAt);
    }
  }

  async function runOnce() {
    const startedAt = now();
    const timing = {
      reclaimMs: 0, claimMs: 0, discoveryMs: 0, marketMs: 0,
      appendMs: 0, settleMs: 0, totalMs: 0,
    };
    const reclaimed = await measured(
      timing, 'reclaimMs', () => outbox.reclaimExpiredLeases()
    );
    const rows = await measured(
      timing, 'claimMs', () => outbox.claimNextBlock({ owner, leaseMs, maxBlocks })
    );
    if (!rows.length) return {
      reclaimed, blockNumber: null, throughBlock: null, blocks: 0,
      claimed: 0, inserted: 0, duplicates: 0,
      ignored: 0, completed: 0, blocked: 0, retried: 0,
      timing: { ...timing, totalMs: Math.max(0, now() - startedAt) },
    };
    const discoveryRows = rows.filter((row) => row.domain === 'discovery');
    const marketRows = rows.filter((row) => row.domain === 'market');
    const blockNumbers = [...new Set(rows.map((row) => String(row.block_number)))];
    const throughBlock = blockNumbers.at(-1);
    try {
      const discovery = await measured(timing, 'discoveryMs', () => (
        pipeline.processDiscoveryRange(discoveryRows.map(logFromRow))
      ));
      const market = await measured(timing, 'marketMs', () => (
        pipeline.processMarketRange(marketRows.map(logFromRow))
      ));
      const entries = [
        ...discovery.map((entry) => captureEntry(entry, 'discovery')),
        ...market.map((entry) => captureEntry(entry, 'market')),
      ].filter(Boolean);
      const appended = await measured(timing, 'appendMs', () => (
        typeof headRepository.appendCanonicalBatch === 'function'
          ? headRepository.appendCanonicalBatch({ entries, frontier: frontierOf(rows, throughBlock) })
          : headRepository.appendCaptureEntries({ entries })
      ));
      const settled = await measured(timing, 'settleMs', () => outbox.settle({
        owner, complete: rows.map(identity), maxAttempts,
      }));
      timing.totalMs = Math.max(0, now() - startedAt);
      return {
        reclaimed, blockNumber: blockNumbers[0], throughBlock, blocks: blockNumbers.length,
        claimed: rows.length,
        inserted: appended.insertedCaptures, duplicates: appended.duplicateCaptures,
        ignored: rows.length - entries.length, ...settled, timing,
      };
    } catch (error) {
      const retry = rows.map((row) => ({
        ...identity(row), error: { code: error.code || 'capture_failed', message: error.message },
        backoffMs: backoff(row.attempt_count, baseBackoffMs, maxBackoffMs),
      }));
      const settled = await measured(timing, 'settleMs', () => (
        outbox.settle({ owner, retry, maxAttempts })
      ));
      timing.totalMs = Math.max(0, now() - startedAt);
      return {
        reclaimed, blockNumber: blockNumbers[0], throughBlock, blocks: blockNumbers.length,
        claimed: rows.length,
        inserted: 0, duplicates: 0, ignored: 0, completed: 0, ...settled, timing,
      };
    }
  }

  return Object.freeze({ owner, runOnce });
}

module.exports = { backoff, createRobinhoodCanonicalHeadRunner };
