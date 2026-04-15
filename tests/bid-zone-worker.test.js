const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const tokenMarketBucket1m = require('../src/models/token-market-bucket-1m');
const tokenMarketBidZoneRun = require('../src/models/token-market-bid-zone-run');
const bidZoneWorker = require('../src/services/bid-zone-worker');

const originalCompute = tokenMarketBucket1m.computeBidZoneCandidates;
const originalStartRun = tokenMarketBidZoneRun.startRun;
const originalCompleteRun = tokenMarketBidZoneRun.completeRun;
const originalFailRun = tokenMarketBidZoneRun.failRun;
const originalCleanupExpiredRuns = tokenMarketBidZoneRun.cleanupExpiredRuns;

describe('bid-zone worker', () => {
  beforeEach(() => {
    bidZoneWorker.stop();
    tokenMarketBucket1m.computeBidZoneCandidates = async () => ([]);
    tokenMarketBidZoneRun.startRun = async () => ({ id: 1 });
    tokenMarketBidZoneRun.completeRun = async () => ({ completed_at: '2026-04-15T12:00:00.000Z' });
    tokenMarketBidZoneRun.failRun = async () => null;
    tokenMarketBidZoneRun.cleanupExpiredRuns = async () => 0;
  });

  after(() => {
    bidZoneWorker.stop();
    tokenMarketBucket1m.computeBidZoneCandidates = originalCompute;
    tokenMarketBidZoneRun.startRun = originalStartRun;
    tokenMarketBidZoneRun.completeRun = originalCompleteRun;
    tokenMarketBidZoneRun.failRun = originalFailRun;
    tokenMarketBidZoneRun.cleanupExpiredRuns = originalCleanupExpiredRuns;
  });

  it('persists only the top limited bid-zone candidates while keeping the full candidate count', async () => {
    const allCandidates = [
      { address: 'So11111111111111111111111111111111111111112', score: 99, reasons: {} },
      { address: 'So11111111111111111111111111111111111111113', score: 98, reasons: {} },
      { address: 'So11111111111111111111111111111111111111114', score: 97, reasons: {} },
    ];
    let completedPayload = null;

    tokenMarketBucket1m.computeBidZoneCandidates = async () => allCandidates;
    tokenMarketBidZoneRun.completeRun = async (_runId, payload) => {
      completedPayload = payload;
      return { completed_at: '2026-04-15T12:00:00.000Z' };
    };

    const result = await bidZoneWorker.runOnce({ limit: 2 }, { triggeredBy: 'test' });

    assert.equal(result.runId, 1);
    assert.equal(result.candidateCount, 3);
    assert.equal(result.resultCount, 2);
    assert.ok(completedPayload);
    assert.equal(completedPayload.candidateCount, 3);
    assert.equal(completedPayload.candidates.length, 2);
  });

  it('enforces a global cooldown for manual refreshes', async () => {
    await bidZoneWorker.runManualRefresh({ limit: 2 });

    const secondAttempt = await bidZoneWorker.runManualRefresh({ limit: 2 });

    assert.equal(secondAttempt.accepted, false);
    assert.ok(Number(secondAttempt.retryAfterSeconds) >= 1);
  });

  it('cleans up terminal bid-zone snapshots older than the retention window after a run', async () => {
    let cleanupOptions = null;
    tokenMarketBidZoneRun.cleanupExpiredRuns = async (options) => {
      cleanupOptions = options;
      return 3;
    };

    await bidZoneWorker.runOnce({ limit: 2 }, { triggeredBy: 'test' });

    assert.deepEqual(cleanupOptions, { maxAgeMs: bidZoneWorker.SNAPSHOT_RETENTION_MS });
    assert.equal(bidZoneWorker.getStatus().lastCleanupDeletedRuns, 3);
    assert.ok(bidZoneWorker.getStatus().lastCleanupAt);
  });
});
