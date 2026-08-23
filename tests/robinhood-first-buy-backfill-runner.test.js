const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  executeBackfill, plan, runPreflight,
} = require('../src/services/robinhood-first-buy-backfill-runner');
const {
  assertDurableSourceCoverage, leaseMsForStatementTimeout, parseArgs,
} = require('../src/utils/backfill-robinhood-first-buys');

const SOURCE = {
  sourceFrom: '2026-08-22T00:00:00Z', sourceThrough: '2026-08-22T04:00:00Z',
  rangeSeconds: 3600,
};

describe('Robinhood first-buy backfill runner', () => {
  it('samples the full window and projects a conservative bounded ETA', async () => {
    const workload = plan({ ...SOURCE, sampleCount: 2 });
    assert.deepEqual(workload.samples, [
      { rangeStart: '2026-08-22T00:00:00.000Z', rangeEnd: '2026-08-22T01:00:00.000Z' },
      { rangeStart: '2026-08-22T03:00:00.000Z', rangeEnd: '2026-08-22T04:00:00.000Z' },
    ]);
    const times = [0, 100, 100, 300];
    const result = await runPreflight({
      now: () => times.shift(),
      firstBuyRepository: { async probeRange(range) {
        return { ...range, rowsScanned: 2, factsConsidered: 1, missingPositions: 0 };
      } },
    }, { ...SOURCE, sampleCount: 2, concurrency: 2 });
    assert.equal(result.averageSampleMs, 150);
    assert.equal(result.projectedMs, 375);
    assert.equal(result.safetyFactor, 1.25);
    assert.equal(result.approved, true);
  });

  it('refuses missing canonical positions and an ETA above five hours', async () => {
    const missing = await runPreflight({
      now: (() => { let value = 0; return () => { value += 10; return value; }; })(),
      firstBuyRepository: { async probeRange(range) {
        return { ...range, missingPositions: 1 };
      } },
    }, { ...SOURCE, sampleCount: 1 });
    assert.equal(missing.approved, false);
    await assert.rejects(executeBackfill({}, { preflight: missing }),
      (error) => error.code === 'first_buy_backfill_preflight_refused');
    const tooSlow = await runPreflight({
      now: (() => { const values = [0, 7_200_000]; return () => values.shift(); })(),
      firstBuyRepository: { async probeRange(range) {
        return { ...range, missingPositions: 0 };
      } },
    }, { ...SOURCE, sampleCount: 1, concurrency: 1 });
    assert.equal(tooSlow.projectedHours, 10);
    assert.equal(tooSlow.approved, false);
    assert.throws(() => plan({ ...SOURCE, rangeSeconds: 30 }), /between 60 and 86400/);
    await assert.rejects(runPreflight({ firstBuyRepository: { probeRange() {} } }, {
      ...SOURCE, maxHours: 5.1,
    }), /at most 5/);
  });

  it('creates and drains an approved checkpointed campaign', async () => {
    let claimed = false;
    let completed = false;
    const calls = [];
    const backfillRepository = {
      async createRun(input) { calls.push(['create', input]); return { id: '7', status: 'planned' }; },
      async startRun(id) { calls.push(['start', id]); },
      async reclaimExpired(id) { calls.push(['reclaim', id]); return 0; },
      async claimRange() {
        if (claimed) return null;
        claimed = true;
        return { id: '8', rangeStart: SOURCE.sourceFrom, rangeEnd: SOURCE.sourceThrough,
          attemptCount: 1 };
      },
      async completeRange(input) { completed = true; calls.push(['complete', input]); },
      async retryRange() { throw new Error('unexpected retry'); },
      async getProgress() {
        return { status: completed ? 'completed' : 'running', total: 1,
          completed: completed ? 1 : 0, progressPct: completed ? 100 : 0 };
      },
    };
    const preflight = { ...SOURCE, approved: true, concurrency: 1 };
    const result = await executeBackfill({
      backfillRepository,
      firstBuyRepository: { async materializeRange() {
        return { rowsScanned: 4, factsConsidered: 2, factsWritten: 2 };
      } },
    }, { preflight });
    assert.equal(result.status, 'completed');
    assert.equal(result.runId, '7');
    assert.deepEqual(calls.map(([name]) => name), ['create', 'start', 'reclaim', 'complete']);
  });

  it('requeues only an explicitly failed campaign before resuming', async () => {
    const calls = [];
    const backfillRepository = {
      async getRun() { return { id: '7', status: 'failed', ...SOURCE }; },
      async resumeFailed(id) { calls.push(['resume', id]); return { runId: id, requeued: 2 }; },
      async reclaimExpired(id) { calls.push(['reclaim', id]); return 0; },
      async claimRange() { return null; },
      async getProgress() { return { status: 'completed', total: 4, completed: 4 }; },
    };
    const result = await executeBackfill({
      backfillRepository,
      firstBuyRepository: { async materializeRange() {} },
    }, {
      preflight: { ...SOURCE, approved: true, concurrency: 1 },
      runId: '7', retryFailed: true,
    });

    assert.equal(result.status, 'completed');
    assert.deepEqual(calls, [['resume', '7'], ['reclaim', '7']]);
  });

  it('keeps CLI writes opt-in and supports run-id resume preflight', () => {
    assert.equal(parseArgs(['--from=2026-08-22T00:00:00Z',
      '--through=2026-08-22T01:00:00Z']).apply, false);
    assert.deepEqual(parseArgs(['--run-id=12', '--apply']).runId, '12');
    assert.deepEqual(parseArgs([
      '--run-id=12', '--apply', '--retry-failed', '--statement-timeout-ms=600000',
    ]), {
      apply: true, retryFailed: true, runId: '12', statementTimeoutMs: 600000,
      sourceFrom: undefined, sourceThrough: undefined, rangeSeconds: 3600,
      concurrency: 2, sampleCount: 3, maxHours: 5,
    });
    assert.throws(() => parseArgs(['--apply']), /--from and --through/);
    assert.throws(() => parseArgs(['--run-id=12', '--from=x']), /cannot be combined/);
    assert.throws(() => parseArgs(['--run-id=12', '--retry-failed']), /requires/);
    assert.throws(() => parseArgs([
      '--run-id=12', '--apply', '--statement-timeout-ms=999999',
    ]), /between 120000 and 900000/);
    assert.equal(leaseMsForStatementTimeout(), 180_000);
    assert.equal(leaseMsForStatementTimeout(120_000), 180_000);
    assert.equal(leaseMsForStatementTimeout(600_000), 660_000);
    assert.equal(leaseMsForStatementTimeout(900_000), 960_000);
  });

  it('refuses a backfill beyond the durable wallet-swap frontier', async () => {
    const sourceCursors = { async loadRetentionGate() { return {
      valid: true, completeThroughBlock: '100',
      seed: { lifecycleState: 'complete' },
      live: { checkpointTimestamp: '2026-08-22T01:00:00.000Z' },
    }; } };
    await assert.rejects(assertDurableSourceCoverage(
      sourceCursors, '2026-08-22T01:00:01.000Z'
    ), (error) => error.code === 'first_buy_source_ahead');
    assert.deepEqual(await assertDurableSourceCoverage(
      sourceCursors, '2026-08-22T01:00:00.001Z'
    ), { durableThrough: '2026-08-22T01:00:00.001Z', completeThroughBlock: '100' });
  });
});
