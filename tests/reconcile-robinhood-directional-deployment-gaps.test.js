process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  CONFIRM_FLAG, main, parseArgs,
} = require('../src/utils/reconcile-robinhood-directional-deployment-gaps');

describe('Robinhood directional deployment gap reconciliation CLI', () => {
  it('is read-only by default and validates bounded arguments', async () => {
    assert.deepEqual(parseArgs(['--run-id=1']), {
      confirm: false, runId: '1', batchSize: 500, maxBatches: 100,
    });
    assert.throws(() => parseArgs([]), /--run-id is required/);
    assert.throws(() => parseArgs(['--run-id=1', '--batch-size=501']), /between 1 and 500/);
    const calls = [];
    const report = await main(['--run-id=1'], {
      logger: { log() {} },
      repository: {
        async planDeploymentGapReconciliation(runId) {
          calls.push(runId);
          return { total: 2, exact: 1, unresolved: 1, ready: 1, leased: 0, published: 0 };
        },
      },
    });
    assert.equal(report.mode, 'read-only');
    assert.deepEqual(calls, ['1']);
  });

  it('drains exact gaps in bounded batches and reports the remainder', async () => {
    const plans = [
      { total: 2, exact: 1, unresolved: 1, ready: 1, leased: 0, published: 0 },
      { total: 1, exact: 0, unresolved: 1, ready: 0, leased: 0, published: 0 },
    ];
    let batches = 0;
    const report = await main([
      '--run-id=1', CONFIRM_FLAG, '--batch-size=1', '--max-batches=3',
    ], {
      logger: { log() {} },
      repository: {
        async planDeploymentGapReconciliation() { return plans.shift(); },
        async reconcileDeploymentGaps() {
          batches += 1;
          return batches === 1
            ? { selected: 1, resolved: 1, staged: 1, alreadyPublished: 0,
              gapAssociationsCleared: 3 }
            : { selected: 1, resolved: 0, staged: 0, alreadyPublished: 0,
              gapAssociationsCleared: 0 };
        },
      },
    });
    assert.equal(report.mode, 'apply');
    assert.equal(report.batches.length, 2);
    assert.equal(report.after.unresolved, 1);
  });
});
