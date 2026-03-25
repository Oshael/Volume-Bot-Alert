const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const tokenMarketBucket1m = require('../src/models/token-market-bucket-1m');
const tokenMarketLateralizationRun = require('../src/models/token-market-lateralization-run');
const lateralizationWorker = require('../src/services/lateralization-worker');

const originalCompute = tokenMarketBucket1m.computeLateralizedCandidates;
const originalStartRun = tokenMarketLateralizationRun.startRun;
const originalCompleteRun = tokenMarketLateralizationRun.completeRun;
const originalFailRun = tokenMarketLateralizationRun.failRun;

describe('lateralization worker', () => {
  beforeEach(() => {
    lateralizationWorker.stop();
    tokenMarketBucket1m.computeLateralizedCandidates = async () => ([]);
    tokenMarketLateralizationRun.startRun = async () => ({ id: 1 });
    tokenMarketLateralizationRun.completeRun = async () => ({ completed_at: '2026-03-25T12:00:00.000Z' });
    tokenMarketLateralizationRun.failRun = async () => null;
  });

  after(() => {
    lateralizationWorker.stop();
    tokenMarketBucket1m.computeLateralizedCandidates = originalCompute;
    tokenMarketLateralizationRun.startRun = originalStartRun;
    tokenMarketLateralizationRun.completeRun = originalCompleteRun;
    tokenMarketLateralizationRun.failRun = originalFailRun;
  });

  it('persists the top limited results while tracking the full candidate count', async () => {
    const allCandidates = [
      { address: 'So11111111111111111111111111111111111111112', score: 99, reasons: {} },
      { address: 'So11111111111111111111111111111111111111113', score: 98, reasons: {} },
      { address: 'So11111111111111111111111111111111111111114', score: 97, reasons: {} },
    ];
    let completedPayload = null;

    tokenMarketBucket1m.computeLateralizedCandidates = async () => allCandidates;
    tokenMarketLateralizationRun.completeRun = async (_runId, payload) => {
      completedPayload = payload;
      return { completed_at: '2026-03-25T12:00:00.000Z' };
    };

    const result = await lateralizationWorker.runOnce({ limit: 2 }, { triggeredBy: 'test' });

    assert.equal(result.runId, 1);
    assert.equal(result.candidateCount, 3);
    assert.equal(result.resultCount, 2);
    assert.ok(completedPayload);
    assert.equal(completedPayload.candidateCount, 3);
    assert.equal(completedPayload.candidates.length, 2);
  });

  it('fails concurrent manual runs instead of starting a second calculation', async () => {
    let release;
    tokenMarketBucket1m.computeLateralizedCandidates = () => new Promise((resolve) => {
      release = resolve;
    });

    const firstRunPromise = lateralizationWorker.runOnce({}, { triggeredBy: 'test' });
    await assert.rejects(
      lateralizationWorker.runOnce({}, { triggeredBy: 'test' }),
      /already has an active run/
    );

    release([]);
    await firstRunPromise;
  });
});
