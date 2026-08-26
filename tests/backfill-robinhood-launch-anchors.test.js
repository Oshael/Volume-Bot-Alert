const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  execute, main, parseArgs,
} = require('../src/utils/backfill-robinhood-launch-anchors');

const OPTIONS = Object.freeze({
  apply: false, runId: null, batchSize: 10, concurrency: 1,
  sampleCount: 1, maxHours: 5, statementTimeoutMs: 1_000,
});

describe('Robinhood launch-anchor backfill command', () => {
  it('is read-only by default and validates operational bounds', () => {
    assert.deepEqual(parseArgs([]), {
      apply: false, runId: null, batchSize: 500, concurrency: 4,
      sampleCount: 3, maxHours: 5, statementTimeoutMs: 120_000,
    });
    assert.equal(parseArgs(['--run-id=7', '--apply']).runId, '7');
    assert.throws(() => parseArgs(['--max-hours=6']), /between 1 and 5/);
    assert.throws(() => parseArgs(['--apply', '--apply']), /unknown or repeated/);
    assert.throws(() => parseArgs(['--wat=1']), /unknown or repeated/);
  });

  it('reports preflight without creating a campaign or exposing targets', async () => {
    const logs = [];
    const targets = [{ tokenAddress: `0x${'1'.repeat(40)}` }];
    const repository = {
      async loadPlan() { return { ready: true, sourceThroughBlock: '20',
        unavailableWithoutPool: 0, targets }; },
      async probeTargets() { return { targets: 1, anchors: 1, unavailable: 0 }; },
      async createRun() { throw new Error('unexpected write'); },
    };
    const times = [0, 10];
    const report = await main([], {
      options: OPTIONS, repository, now: () => times.shift(),
      logger: { log: (line) => logs.push(line) },
    });
    assert.equal(report.mode, 'preflight');
    assert.equal(report.approved, true);
    assert.equal(report.candidateTargets, 1);
    assert.equal(JSON.stringify(report).includes('tokenAddress'), false);
    assert.equal(logs.length, 1);
  });

  it('creates an approved run and halves a timed-out batch before completing', async () => {
    const limits = [];
    let progressCalls = 0;
    const repository = {
      async createRun() { return { id: '7' }; },
      async getProgress() {
        progressCalls += 1;
        return progressCalls === 1
          ? { status: 'running', total: 1, completed: 0, unavailable: 0,
            failed: 0, progressPct: 0, etaSeconds: null }
          : { status: 'completed', total: 1, completed: 1, unavailable: 0,
            failed: 0, progressPct: 100, etaSeconds: 0 };
      },
      async materializeBatch({ limit }) {
        limits.push(limit);
        if (limit === 20) throw Object.assign(new Error('statement timeout'), { code: '57014' });
        return { status: 'completed', claimed: 1 };
      },
    };
    let timestamp = 0;
    const result = await execute(repository, {
      report: { approved: true }, plan: { targets: [{}] },
    }, { ...OPTIONS, apply: true, batchSize: 20, maxHours: 1 }, {
      now: () => timestamp += 10, owner: 'test', sleep: async () => {},
      logger: { log() {}, error() {} },
    });
    assert.deepEqual(limits, [20, 10]);
    assert.equal(result.runId, '7');
    assert.equal(result.status, 'completed');
  });

  it('refuses writes when the mandatory preflight is not approved', async () => {
    await assert.rejects(execute({}, {
      report: { approved: false }, plan: { targets: [] },
    }, OPTIONS), (error) => error.code === 'launch_anchor_backfill_preflight_refused');
  });
});
