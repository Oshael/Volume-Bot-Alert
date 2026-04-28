const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const candidates = require('../src/services/pumpfun-fast-5x-candidates');
const detectionStore = require('../src/models/pumpfun-fast-5x-detection');
const dryRun = require('../src/services/pumpfun-fast-5x-dry-run');

function buildCandidate(overrides = {}) {
  return {
    address: 'So11111111111111111111111111111111111111112',
    symbol: 'FAST',
    name: 'Fast Token',
    migrationStartedAt: '2026-04-27T10:00:00.000Z',
    currentBucketAt: '2026-04-27T10:06:00.000Z',
    signalInput: {
      source: 'pumpfun-migrated',
      migrationAgeMs: 6 * 60 * 1000,
      firstMcap: 24_000,
      currentMcap: 58_000,
      p95McapRecent: 61_000,
      p95Vol5mRecent: 85_000,
      avgVol5mFirst30m: 72_000,
      timeTo2xMs: 4 * 60 * 1000,
      bucketCoverage: 28,
      ...overrides.signalInput,
    },
    ...overrides,
  };
}

afterEach(() => {
  dryRun.__private.resetStatus();
});

describe('PumpFun fast 5x dry-run runtime', () => {
  it('stays stopped when disabled', () => {
    dryRun.start({ enabled: false });

    const status = dryRun.getStatus();
    assert.equal(status.running, false);
    assert.equal(status.enabled, false);
  });

  it('refuses non dry-run mode until alert emission is implemented', () => {
    dryRun.start({ enabled: true, dryRun: false });

    const status = dryRun.getStatus();
    assert.equal(status.running, false);
    assert.equal(status.enabled, true);
    assert.equal(status.dryRun, false);
    assert.equal(status.lastError, 'alert_emission_not_implemented');
  });

  it('evaluates candidates and stores compact pass diagnostics without emitting alerts', async () => {
    const originalListCandidates = candidates.listPumpfunFast5xCandidates;
    const originalListOutcomes = candidates.listPumpfunFast5xOutcomesSinceAlert;
    const originalListDetections = detectionStore.listRecentDetections;
    const originalUpsertDetection = detectionStore.upsertDetection;
    const persisted = [];
    candidates.listPumpfunFast5xCandidates = async () => [
      buildCandidate(),
      buildCandidate({
        address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        signalInput: {
          currentMcap: 30_000,
          p95McapRecent: 31_000,
        },
      }),
    ];
    candidates.listPumpfunFast5xOutcomesSinceAlert = async () => [{
      address: 'So11111111111111111111111111111111111111112',
      maxMcapSinceAlert: 116_000,
      maxMcapBucketAt: '2026-04-27T10:12:00.000Z',
      latestMcapSinceAlert: 90_000,
      latestBucketAt: '2026-04-27T10:15:00.000Z',
    }];
    detectionStore.listRecentDetections = async () => [];
    detectionStore.upsertDetection = async (detection) => {
      persisted.push(detection);
      return detection;
    };

    try {
      dryRun.start({ enabled: true, dryRun: true, intervalMs: 60_000, candidateLimit: 50 });
      const summary = await dryRun.runOnce({ force: true, now: '2026-04-27T10:15:00.000Z' });
      const status = dryRun.getStatus();

      assert.equal(summary.candidates.length, 2);
      assert.equal(summary.passed.length, 1);
      assert.equal(status.running, true);
      assert.equal(status.dryRun, true);
      assert.equal(status.lastCandidateCount, 2);
      assert.equal(status.lastPassedCount, 1);
      assert.equal(status.lastFailedCount, 1);
      assert.equal(status.lastPassedCandidates.length, 1);
      assert.equal(status.lastPassedCandidates[0].address, 'So11111111111111111111111111111111111111112');
      assert.ok(status.lastPassedCandidates[0].evidence);
      assert.equal(status.trackedDetectionCount, 1);
      assert.equal(status.trackedDetections[0].alertMcap, 58_000);
      assert.equal(status.trackedDetections[0].maxMcapSinceAlert, 116_000);
      assert.equal(status.trackedDetections[0].maxXSinceAlert, 2);
      assert.equal(summary.detections.length, 1);
      assert.equal(persisted.some((item) => item.address === 'So11111111111111111111111111111111111111112'), true);
    } finally {
      candidates.listPumpfunFast5xCandidates = originalListCandidates;
      candidates.listPumpfunFast5xOutcomesSinceAlert = originalListOutcomes;
      detectionStore.listRecentDetections = originalListDetections;
      detectionStore.upsertDetection = originalUpsertDetection;
    }
  });

  it('hydrates recent persisted detections before refreshing outcomes', async () => {
    const originalListCandidates = candidates.listPumpfunFast5xCandidates;
    const originalListOutcomes = candidates.listPumpfunFast5xOutcomesSinceAlert;
    const originalListDetections = detectionStore.listRecentDetections;
    const originalUpsertDetection = detectionStore.upsertDetection;
    const persistedUpdates = [];

    candidates.listPumpfunFast5xCandidates = async () => [];
    candidates.listPumpfunFast5xOutcomesSinceAlert = async () => [{
      address: 'So11111111111111111111111111111111111111112',
      maxMcapSinceAlert: 150_000,
      maxMcapBucketAt: '2026-04-27T10:30:00.000Z',
      latestMcapSinceAlert: 120_000,
      latestBucketAt: '2026-04-27T10:35:00.000Z',
    }];
    detectionStore.listRecentDetections = async () => [{
      address: 'So11111111111111111111111111111111111111112',
      symbol: 'FAST',
      name: 'Fast Token',
      migrationStartedAt: '2026-04-27T10:00:00.000Z',
      alertTriggeredAt: '2026-04-27T10:06:00.000Z',
      alertMcap: 50_000,
      alertMultipleFromFirstMcap: 2,
      score: 140,
      reason: 'fast_pump',
      evidenceAtAlert: { currentMcap: 50_000 },
      latestMcapSinceAlert: 50_000,
      latestBucketAt: '2026-04-27T10:06:00.000Z',
      maxMcapSinceAlert: 50_000,
      maxMcapBucketAt: '2026-04-27T10:06:00.000Z',
      maxXSinceAlert: 1,
      firstMatchedAt: '2026-04-27T10:06:00.000Z',
      lastMatchedAt: '2026-04-27T10:06:00.000Z',
      lastUpdatedAt: '2026-04-27T10:06:00.000Z',
      matchedRuns: 1,
    }];
    detectionStore.upsertDetection = async (detection) => {
      persistedUpdates.push(detection);
      return detection;
    };

    try {
      const summary = await dryRun.runOnce({ force: true, now: '2026-04-27T10:35:00.000Z' });

      assert.equal(summary.passed.length, 0);
      assert.equal(summary.detections.length, 1);
      assert.equal(summary.detections[0].maxMcapSinceAlert, 150_000);
      assert.equal(summary.detections[0].maxXSinceAlert, 3);
      assert.equal(persistedUpdates.length, 1);
      assert.equal(persistedUpdates[0].latestMcapSinceAlert, 120_000);
    } finally {
      candidates.listPumpfunFast5xCandidates = originalListCandidates;
      candidates.listPumpfunFast5xOutcomesSinceAlert = originalListOutcomes;
      detectionStore.listRecentDetections = originalListDetections;
      detectionStore.upsertDetection = originalUpsertDetection;
    }
  });

  it('passes bounded runtime options into the candidate builder', async () => {
    const originalListCandidates = candidates.listPumpfunFast5xCandidates;
    const originalListOutcomes = candidates.listPumpfunFast5xOutcomesSinceAlert;
    const originalListDetections = detectionStore.listRecentDetections;
    const originalUpsertDetection = detectionStore.upsertDetection;
    const calls = [];
    candidates.listPumpfunFast5xCandidates = async (options) => {
      calls.push(options);
      return [];
    };
    candidates.listPumpfunFast5xOutcomesSinceAlert = async () => [];
    detectionStore.listRecentDetections = async () => [];
    detectionStore.upsertDetection = async (detection) => detection;

    try {
      dryRun.start({ enabled: true, candidateLimit: 33 });
      await dryRun.runOnce({
        force: true,
        now: '2026-04-27T10:15:00.000Z',
        maxMigrationAgeMs: 30 * 60 * 1000,
      });

      assert.equal(calls.length >= 1, true);
      assert.equal(calls.at(-1).limit, 33);
      assert.equal(calls.at(-1).maxMigrationAgeMs, 30 * 60 * 1000);
      assert.equal(calls.at(-1).now, '2026-04-27T10:15:00.000Z');
    } finally {
      candidates.listPumpfunFast5xCandidates = originalListCandidates;
      candidates.listPumpfunFast5xOutcomesSinceAlert = originalListOutcomes;
      detectionStore.listRecentDetections = originalListDetections;
      detectionStore.upsertDetection = originalUpsertDetection;
    }
  });

  it('normalizes options with safe caps', () => {
    const options = dryRun.__private.resolveOptions({
      enabled: true,
      dryRun: false,
      intervalMs: 1,
      candidateLimit: 5000,
    });

    assert.equal(options.enabled, true);
    assert.equal(options.dryRun, false);
    assert.equal(options.intervalMs, 10_000);
    assert.equal(options.candidateLimit, 500);
    assert.equal(options.outcomeWindowMs, 5 * 60 * 60 * 1000);
  });
});
