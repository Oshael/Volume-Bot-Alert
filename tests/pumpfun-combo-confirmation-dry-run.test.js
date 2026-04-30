const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const candidates = require('../src/services/pumpfun-combo-confirmation-candidates');
const detectionStore = require('../src/models/pumpfun-combo-confirmation-detection');
const dryRun = require('../src/services/pumpfun-combo-confirmation-dry-run');

function buildCandidate(overrides = {}) {
  return {
    address: '12eM87tTACWpgnwuapFUHDVDXFaZSxJqxBNj1AHB56sy',
    symbol: 'COMBO',
    name: 'Combo Token',
    migrationStartedAt: '2026-04-29T00:18:00.000Z',
    currentBucketAt: '2026-04-29T00:21:00.000Z',
    blastAlertTriggeredAt: '2026-04-29T00:21:00.000Z',
    fastAlertTriggeredAt: null,
    signalInput: {
      blastAlertMcap: 80_000,
      blastScore: 135,
      blastTimeToHighMcapMs: 3 * 60 * 1000,
      blastHighMcapRecent: 110_000,
      blastStrongestVol5m: 130_000,
      hasFastConfirmation: false,
      preBuckets: 3,
      preHighMcap: 28_000,
      maxPreVol5m: 22_000,
      ...overrides.signalInput,
    },
    sourceEvidence: {
      blast: { highMcapRecent: 110_000 },
      fast: {},
    },
    ...overrides,
  };
}

afterEach(() => {
  dryRun.__private.resetStatus();
});

describe('PumpFun combo confirmation dry-run runtime', () => {
  it('stays stopped when disabled', () => {
    dryRun.start({ enabled: false });

    const status = dryRun.getStatus();
    assert.equal(status.running, false);
    assert.equal(status.enabled, false);
  });

  it('evaluates combo candidates and persists tracked outcomes', async () => {
    const originalListCandidates = candidates.listPumpfunComboConfirmationCandidates;
    const originalListOutcomes = candidates.listPumpfunComboConfirmationOutcomesSinceAlert;
    const originalListDetections = detectionStore.listRecentDetections;
    const originalUpsertDetection = detectionStore.upsertDetection;
    const persisted = [];

    candidates.listPumpfunComboConfirmationCandidates = async () => [
      buildCandidate(),
      buildCandidate({
        address: 'So11111111111111111111111111111111111111112',
        signalInput: { blastAlertMcap: 120_000 },
      }),
    ];
    candidates.listPumpfunComboConfirmationOutcomesSinceAlert = async () => [{
      address: '12eM87tTACWpgnwuapFUHDVDXFaZSxJqxBNj1AHB56sy',
      maxMcapSinceAlert: 320_000,
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
      assert.equal(status.trackedDetections[0].alertMcap, 80_000);
      assert.equal(status.trackedDetections[0].maxMcapSinceAlert, 320_000);
      assert.equal(status.trackedDetections[0].maxXSinceAlert, 4);
      assert.equal(persisted.some((item) => item.address === '12eM87tTACWpgnwuapFUHDVDXFaZSxJqxBNj1AHB56sy'), true);
    } finally {
      candidates.listPumpfunComboConfirmationCandidates = originalListCandidates;
      candidates.listPumpfunComboConfirmationOutcomesSinceAlert = originalListOutcomes;
      detectionStore.listRecentDetections = originalListDetections;
      detectionStore.upsertDetection = originalUpsertDetection;
    }
  });
});
