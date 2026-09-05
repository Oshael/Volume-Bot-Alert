const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const {
  parseArgs, runBatches, createDiagnosticClient, failureReport,
} = require('../src/utils/prune-robinhood-holder-journal');
const db = require('../src/models/db');

after(() => db.pool.end());

test('manual journal cleanup requires an explicit bounded cut and write consent', () => {
  assert.deepEqual(parseArgs(['--before-block=38808102', '--write']), {
    beforeBlock: '38808102', retentionBlocks: 20000, batchLimit: 1000,
    maxBatches: 1, pauseMs: 1000,
  });
  assert.deepEqual(parseArgs([
    '--before-block=38808102', '--batch-limit=5000', '--max-batches=20',
    '--pause-ms=250', '--write',
  ]), {
    beforeBlock: '38808102', retentionBlocks: 20000, batchLimit: 5000,
    maxBatches: 20, pauseMs: 250,
  });
  for (const args of [
    [], ['--write'], ['--before-block=38808102'],
    ['--before-block=-1', '--write'], ['--before-block=', '--write'],
    ['--before-block=1e9', '--write'],
    ['--before-block=9223372036854775808', '--write'],
    ['--before-block=1', '--before-block=2', '--write'],
    ['--before-block=1', '--write', '--write'],
    ['--before-block=1', '--batch-limit=5001', '--write'],
    ['--before-block=1', '--batch-limit=0', '--write'],
    ['--before-block=1', '--max-batches=0', '--write'],
    ['--before-block=1', '--max-batches=101', '--write'],
    ['--before-block=1', '--max-batches=1.5', '--write'],
    ['--before-block=1', '--max-batches=', '--write'],
    ['--before-block=1', '--max-batches=1', '--max-batches=2', '--write'],
    ['--before-block=1', '--pause-ms=99', '--write'],
    ['--before-block=1', '--pause-ms=60001', '--write'],
    ['--before-block=1', '--pause-ms=1.5', '--write'],
    ['--before-block=1', '--pause-ms=', '--write'],
    ['--before-block=1', '--write', '--force'],
  ]) assert.throws(() => parseArgs(args), undefined, JSON.stringify(args));
});

test('bounded cleanup commits independent batches until the repository finishes draining', async () => {
  const results = [
    { status: 'draining', deletedEvents: 900, discardedBufferedEvents: 100,
      totalDeleted: 1000, journalFloorBlock: '100' },
    { status: 'draining', deletedEvents: 950, discardedBufferedEvents: 50,
      totalDeleted: 1000, journalFloorBlock: '200' },
    { status: 'pruned', deletedEvents: 20, discardedBufferedEvents: 0,
      totalDeleted: 20, journalFloorBlock: '220' },
  ];
  const pauses = [];
  const progress = [];
  const summary = await runBatches({}, { maxBatches: 20, pauseMs: 250 }, {
    runBatch: async (client, options, diagnostics) => {
      diagnostics.transaction = 'committed';
      return results.shift();
    },
    pause: async (ms) => pauses.push(ms),
    progress: (entry) => progress.push(entry),
  });

  assert.deepEqual(pauses, [250, 250]);
  assert.equal(progress.length, 3);
  assert.equal(progress[0].transaction, 'committed');
  assert.deepEqual(summary, {
    status: 'finished', stopReason: 'pruned', batches: 3, totalDeleted: 2020,
    deletedEvents: 1870, discardedBufferedEvents: 150,
    journalFloorBlock: '220', lastStatus: 'pruned',
  });
});

test('bounded cleanup stops safely on a signal or terminal result', async () => {
  let stopped = false;
  let calls = 0;
  const signal = await runBatches({}, { maxBatches: 20, pauseMs: 250 }, {
    runBatch: async () => {
      calls += 1;
      return { status: 'draining', deletedEvents: 1, totalDeleted: 1,
        journalFloorBlock: '100' };
    },
    pause: async () => { stopped = true; },
    shouldStop: () => stopped,
  });
  assert.equal(calls, 1);
  assert.equal(signal.stopReason, 'signal');
  assert.equal(signal.totalDeleted, 1);

  const blocked = await runBatches({}, { maxBatches: 20, pauseMs: 250 }, {
    runBatch: async () => ({ status: 'blocked', deletedEvents: 0, totalDeleted: 0 }),
    pause: async () => assert.fail('must not pause after a terminal result'),
  });
  assert.equal(blocked.stopReason, 'blocked');
  assert.equal(blocked.batches, 1);
});

test('bounded cleanup reports already committed progress when a later batch fails', async () => {
  let calls = 0;
  const failure = Object.assign(new Error('statement timeout'), { code: '57014' });
  await assert.rejects(runBatches({}, { maxBatches: 2, pauseMs: 250 }, {
    runBatch: async () => {
      calls += 1;
      if (calls === 2) throw failure;
      return { status: 'draining', deletedEvents: 900, discardedBufferedEvents: 100,
        totalDeleted: 1000, journalFloorBlock: '100' };
    },
    pause: async () => {},
  }), (error) => {
    assert.equal(error.batchProgress.batches, 1);
    assert.equal(error.batchProgress.totalDeleted, 1000);
    assert.equal(failureReport(error).progress.journalFloorBlock, '100');
    return true;
  });
});

test('diagnostics retain the failing step and never claim rollback after a lost commit', async () => {
  for (const failedStep of ['check_protected', 'commit']) {
    for (const rollbackFails of [false, true]) {
      const failure = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
      const measured = createDiagnosticClient({
        async query(sql) {
          if (sql === failedStep || (sql === 'rollback' && rollbackFails)) throw failure;
          return { rows: [] };
        },
      });
      await measured.query('begin', 'begin');
      await assert.rejects(measured.query(failedStep, failedStep), /statement timeout/);
      if (rollbackFails) await assert.rejects(measured.query('rollback', 'rollback'));
      else await measured.query('rollback', 'rollback');
      failure.pruneDiagnostics = measured.snapshot();
      const report = failureReport(failure);
      assert.equal(report.failedStep, failedStep);
      assert.equal(report.code, '57014');
      assert.equal(report.transaction,
        rollbackFails || failedStep === 'commit' ? 'unknown' : 'rolled_back');
      assert.ok(report.timingMs[failedStep] >= 0);
      assert.ok(report.timingMs.rollback >= 0);
      assert.ok(report.elapsedMs >= 0);
      assert.equal(report.totalDeleted, undefined);
    }
  }
});
