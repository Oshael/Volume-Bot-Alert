const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const cleanupWorker = require('../src/services/catalog-cleanup-worker');
const tokenMarketBucket1m = require('../src/models/token-market-bucket-1m');
const tokenMarketVolumeBucket1m = require('../src/models/token-market-volume-bucket-1m');
const tokenMeteoraSnapshot = require('../src/models/token-meteora-snapshot');

describe('catalog cleanup worker archive scheduling', () => {
  it('never overlaps maintenance operations from independent timers', async () => {
    const calls = [];
    let releaseFirst;
    const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
    const first = cleanupWorker.__private.enqueueCleanup(async () => {
      calls.push('first:start');
      await firstPending;
      calls.push('first:end');
    });
    const second = cleanupWorker.__private.enqueueCleanup(async () => {
      calls.push('second');
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(calls, ['first:start', 'first:end', 'second']);
  });

  it('serializes initial cleanup before archive scheduling can begin', async () => {
    const calls = [];
    let releaseQuarantine;
    const quarantinePending = new Promise((resolve) => { releaseQuarantine = resolve; });
    const sequence = cleanupWorker.__private.runInitialCleanupSequence({
      runQuarantineOnce: async () => {
        calls.push('quarantine:start');
        await quarantinePending;
        calls.push('quarantine:end');
      },
      runBlockedArtifactCleanupOnce: async () => {
        calls.push('blocked-artifacts');
      },
      initializeArchiveSchedule: async () => {
        calls.push('archive-schedule');
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['quarantine:start']);
    releaseQuarantine();
    await sequence;
    assert.deepEqual(calls, [
      'quarantine:start', 'quarantine:end', 'blocked-artifacts', 'archive-schedule',
    ]);
  });

  it('waits a full archive interval when there is no persisted anchor', () => {
    assert.equal(
      cleanupWorker.__private.computeArchiveDelayMs(null, Date.UTC(2026, 2, 25, 12, 0, 0)),
      48 * 60 * 60 * 1000
    );
  });

  it('keeps only the remaining delay after a recent persisted archive run', () => {
    const now = Date.UTC(2026, 2, 25, 12, 0, 0);
    const tenHoursAgo = new Date(now - (10 * 60 * 60 * 1000));

    assert.equal(
      cleanupWorker.__private.computeArchiveDelayMs(tenHoursAgo, now),
      38 * 60 * 60 * 1000
    );
  });

  it('runs immediately when the persisted archive interval is already overdue', () => {
    const now = Date.UTC(2026, 2, 25, 12, 0, 0);
    const threeDaysAgo = new Date(now - (72 * 60 * 60 * 1000));

    assert.equal(cleanupWorker.__private.computeArchiveDelayMs(threeDaysAgo, now), 0);
  });

  it('slows blocked artifact cleanup when the previous run found no artifacts', () => {
    assert.equal(
      cleanupWorker.__private.computeBlockedArtifactDelayMs({ blockedArtifactTokens: 0 }),
      60 * 60 * 1000
    );
  });

  it('keeps blocked artifact cleanup on a bounded maintenance cadence when artifacts remain', () => {
    assert.equal(
      cleanupWorker.__private.computeBlockedArtifactDelayMs({ blockedArtifactTokens: 25 }),
      15 * 60 * 1000
    );
  });

  it('deletes blocked token artifacts from all cleanup-owned history tables', async () => {
    const originalMarketDelete = tokenMarketBucket1m.deleteChunkByAddress;
    const originalVolumeDelete = tokenMarketVolumeBucket1m.deleteChunkByAddress;
    const originalMeteoraDelete = tokenMeteoraSnapshot.deleteChunkByAddress;
    const calls = [];
    const addresses = [
      'So11111111111111111111111111111111111111112',
      'So11111111111111111111111111111111111111113',
    ];

    tokenMarketBucket1m.deleteChunkByAddress = async (address, options) => {
      calls.push(['market', address, options]);
      return {
        deletedMarketBucketsAgg: 3,
        deletedMarketBuckets1m: 6,
      };
    };
    tokenMarketVolumeBucket1m.deleteChunkByAddress = async (address, options) => {
      calls.push(['volume', address, options]);
      return 5;
    };
    tokenMeteoraSnapshot.deleteChunkByAddress = async (address, options) => {
      calls.push(['meteora', address, options]);
      return 1;
    };

    try {
      const summary = await cleanupWorker.__private.deleteBlockedArtifactsForAddresses(addresses);

      assert.deepEqual(summary, {
        blockedArtifactTokens: 2,
        deletedMarketBucketsAgg: 6,
        deletedMarketBuckets1m: 12,
        deletedMarketVolumeBuckets1m: 10,
        deletedMeteoraSnapshots: 2,
      });
      assert.deepEqual(calls.map(([name, address]) => [name, address]), [
        ['market', addresses[0]],
        ['volume', addresses[0]],
        ['meteora', addresses[0]],
        ['market', addresses[1]],
        ['volume', addresses[1]],
        ['meteora', addresses[1]],
      ]);
      for (const [, , options] of calls) {
        assert.equal(options.limit, 250);
        assert.equal(options.statementTimeoutMs, 2000);
      }
    } finally {
      tokenMarketBucket1m.deleteChunkByAddress = originalMarketDelete;
      tokenMarketVolumeBucket1m.deleteChunkByAddress = originalVolumeDelete;
      tokenMeteoraSnapshot.deleteChunkByAddress = originalMeteoraDelete;
    }
  });
});
