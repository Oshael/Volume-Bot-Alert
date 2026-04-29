const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const candidates = require('../src/services/pumpfun-post-migration-blast-candidates');
const detectionStore = require('../src/models/pumpfun-post-migration-blast-detection');
const dryRun = require('../src/services/pumpfun-post-migration-blast-dry-run');

function buildCandidate(overrides = {}) {
  return {
    address: '12eM87tTACWpgnwuapFUHDVDXFaZSxJqxBNj1AHB56sy',
    symbol: 'BLAST',
    name: 'Blast Token',
    migrationStartedAt: '2026-04-29T00:18:00.000Z',
    currentBucketAt: '2026-04-29T00:21:00.000Z',
    signalInput: {
      source: 'pumpfun-migrated',
      migrationAgeMs: 3 * 60 * 1000,
      firstMcap: 12_355,
      currentMcap: 55_767,
      highMcapRecent: 75_588,
      maxVol5mRecent: 124_518,
      p95Vol5mRecent: 118_000,
      timeToHighMcapMs: 3 * 60 * 1000,
      bucketCoverage: 4,
      ...overrides.signalInput,
    },
    ...overrides,
  };
}

afterEach(() => {
  dryRun.__private.resetStatus();
});

describe('PumpFun post-migration blast dry-run runtime', () => {
  it('stays stopped when disabled', () => {
    dryRun.start({ enabled: false });

    const status = dryRun.getStatus();
    assert.equal(status.running, false);
    assert.equal(status.enabled, false);
  });

  it('evaluates blast candidates and persists tracked outcomes', async () => {
    const originalListCandidates = candidates.listPumpfunPostMigrationBlastCandidates;
    const originalListOutcomes = candidates.listPumpfunPostMigrationBlastOutcomesSinceAlert;
    const originalListDetections = detectionStore.listRecentDetections;
    const originalUpsertDetection = detectionStore.upsertDetection;
    const persisted = [];

    candidates.listPumpfunPostMigrationBlastCandidates = async () => [
      buildCandidate(),
      buildCandidate({
        address: 'So11111111111111111111111111111111111111112',
        signalInput: { maxVol5mRecent: 50_000, p95Vol5mRecent: 45_000 },
      }),
    ];
    candidates.listPumpfunPostMigrationBlastOutcomesSinceAlert = async () => [{
      address: '12eM87tTACWpgnwuapFUHDVDXFaZSxJqxBNj1AHB56sy',
      maxMcapSinceAlert: 300_000,
      maxMcapBucketAt: '2026-04-29T00:25:00.000Z',
      latestMcapSinceAlert: 250_000,
      latestBucketAt: '2026-04-29T00:26:00.000Z',
    }];
    detectionStore.listRecentDetections = async () => [];
    detectionStore.upsertDetection = async (detection) => {
      persisted.push(detection);
      return detection;
    };

    try {
      dryRun.start({ enabled: true, dryRun: true, intervalMs: 60_000, candidateLimit: 50 });
      const summary = await dryRun.runOnce({ force: true, now: '2026-04-29T00:26:00.000Z' });
      const status = dryRun.getStatus();

      assert.equal(summary.candidates.length, 2);
      assert.equal(summary.passed.length, 1);
      assert.equal(status.lastPassedCount, 1);
      assert.equal(status.trackedDetectionCount, 1);
      assert.equal(status.trackedDetections[0].alertMcap, 55_767);
      assert.equal(status.trackedDetections[0].maxMcapSinceAlert, 300_000);
      assert.equal(status.trackedDetections[0].maxXSinceAlert, 5.38);
      assert.equal(persisted.some((item) => item.address === '12eM87tTACWpgnwuapFUHDVDXFaZSxJqxBNj1AHB56sy'), true);
    } finally {
      candidates.listPumpfunPostMigrationBlastCandidates = originalListCandidates;
      candidates.listPumpfunPostMigrationBlastOutcomesSinceAlert = originalListOutcomes;
      detectionStore.listRecentDetections = originalListDetections;
      detectionStore.upsertDetection = originalUpsertDetection;
    }
  });

  it('hydrates persisted detections before refreshing outcomes', async () => {
    const originalListCandidates = candidates.listPumpfunPostMigrationBlastCandidates;
    const originalListOutcomes = candidates.listPumpfunPostMigrationBlastOutcomesSinceAlert;
    const originalListDetections = detectionStore.listRecentDetections;
    const originalUpsertDetection = detectionStore.upsertDetection;
    const persistedUpdates = [];

    candidates.listPumpfunPostMigrationBlastCandidates = async () => [];
    candidates.listPumpfunPostMigrationBlastOutcomesSinceAlert = async () => [{
      address: '12eM87tTACWpgnwuapFUHDVDXFaZSxJqxBNj1AHB56sy',
      maxMcapSinceAlert: 500_000,
      maxMcapBucketAt: '2026-04-29T00:30:00.000Z',
      latestMcapSinceAlert: 450_000,
      latestBucketAt: '2026-04-29T00:31:00.000Z',
    }];
    detectionStore.listRecentDetections = async () => [{
      ...buildCandidate(),
      alertTriggeredAt: '2026-04-29T00:21:00.000Z',
      alertMcap: 50_000,
      score: 120,
      reason: 'passed',
      evidenceAtAlert: { currentMcap: 50_000 },
      latestMcapSinceAlert: 50_000,
      latestBucketAt: '2026-04-29T00:21:00.000Z',
      maxMcapSinceAlert: 50_000,
      maxMcapBucketAt: '2026-04-29T00:21:00.000Z',
      maxXSinceAlert: 1,
      firstMatchedAt: '2026-04-29T00:21:00.000Z',
      lastMatchedAt: '2026-04-29T00:21:00.000Z',
      lastUpdatedAt: '2026-04-29T00:21:00.000Z',
      matchedRuns: 1,
    }];
    detectionStore.upsertDetection = async (detection) => {
      persistedUpdates.push(detection);
      return detection;
    };

    try {
      const summary = await dryRun.runOnce({ force: true, now: '2026-04-29T00:31:00.000Z' });

      assert.equal(summary.passed.length, 0);
      assert.equal(summary.detections.length, 1);
      assert.equal(summary.detections[0].maxMcapSinceAlert, 500_000);
      assert.equal(summary.detections[0].maxXSinceAlert, 10);
      assert.equal(persistedUpdates[0].latestMcapSinceAlert, 450_000);
    } finally {
      candidates.listPumpfunPostMigrationBlastCandidates = originalListCandidates;
      candidates.listPumpfunPostMigrationBlastOutcomesSinceAlert = originalListOutcomes;
      detectionStore.listRecentDetections = originalListDetections;
      detectionStore.upsertDetection = originalUpsertDetection;
    }
  });
});
