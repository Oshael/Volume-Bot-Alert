const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const cleanupWorker = require('../src/services/catalog-cleanup-worker');
const tokenMarketBucket1m = require('../src/models/token-market-bucket-1m');
const tokenMarketVolumeBucket1m = require('../src/models/token-market-volume-bucket-1m');
const tokenMeteoraSnapshot = require('../src/models/token-meteora-snapshot');

describe('catalog cleanup worker archive scheduling', () => {
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
    const originalMarketDelete = tokenMarketBucket1m.deleteByAddresses;
    const originalVolumeDelete = tokenMarketVolumeBucket1m.deleteByAddresses;
    const originalMeteoraDelete = tokenMeteoraSnapshot.deleteByAddresses;
    const calls = [];
    const addresses = [
      'So11111111111111111111111111111111111111112',
      'So11111111111111111111111111111111111111113',
    ];

    tokenMarketBucket1m.deleteByAddresses = async (items) => {
      calls.push(['market', items]);
      return 12;
    };
    tokenMarketVolumeBucket1m.deleteByAddresses = async (items) => {
      calls.push(['volume', items]);
      return 10;
    };
    tokenMeteoraSnapshot.deleteByAddresses = async (items) => {
      calls.push(['meteora', items]);
      return 2;
    };

    try {
      const summary = await cleanupWorker.__private.deleteBlockedArtifactsForAddresses(addresses);

      assert.deepEqual(summary, {
        blockedArtifactTokens: 2,
        deletedMarketBuckets1m: 12,
        deletedMarketVolumeBuckets1m: 10,
        deletedMeteoraSnapshots: 2,
      });
      assert.equal(calls.length, 3);
      assert.deepEqual(calls.map(([name]) => name).sort(), ['market', 'meteora', 'volume']);
      for (const [, items] of calls) {
        assert.deepEqual(items, addresses);
      }
    } finally {
      tokenMarketBucket1m.deleteByAddresses = originalMarketDelete;
      tokenMarketVolumeBucket1m.deleteByAddresses = originalVolumeDelete;
      tokenMeteoraSnapshot.deleteByAddresses = originalMeteoraDelete;
    }
  });
});
