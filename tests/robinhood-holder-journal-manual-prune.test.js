const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const {
  parseArgs, createDiagnosticClient, failureReport,
} = require('../src/utils/prune-robinhood-holder-journal');
const db = require('../src/models/db');

after(() => db.pool.end());

test('manual journal cleanup requires an explicit bounded cut and write consent', () => {
  assert.deepEqual(parseArgs(['--before-block=38808102', '--write']), {
    beforeBlock: '38808102', retentionBlocks: 20000, batchLimit: 1000,
  });
  for (const args of [
    [], ['--write'], ['--before-block=38808102'],
    ['--before-block=-1', '--write'], ['--before-block=', '--write'],
    ['--before-block=1e9', '--write'],
    ['--before-block=9223372036854775808', '--write'],
    ['--before-block=1', '--before-block=2', '--write'],
    ['--before-block=1', '--write', '--write'],
    ['--before-block=1', '--batch-limit=1001', '--write'],
    ['--before-block=1', '--batch-limit=0', '--write'],
    ['--before-block=1', '--write', '--force'],
  ]) assert.throws(() => parseArgs(args), undefined, JSON.stringify(args));
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
