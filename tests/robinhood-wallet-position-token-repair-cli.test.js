const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  CONFIRM_FLAG, main, parseArgs,
} = require('../src/utils/repair-robinhood-wallet-positions');

describe('Robinhood token-scoped position repair CLI', () => {
  it('stays read-only by default and keeps the archive runtime lazy', async () => {
    const report = await main(['--max-blocks=250', '--window-concurrency=2'], {
      database: {}, logger: { log() {} },
      repositoryFactory: () => ({
        async preview() { return { eligible: 391, initialized: 0, missing: 391 }; },
        async plan() {
          return {
            candidates: 0, earliest_pending_block: '100', latest_pending_block: '1099',
          };
        },
      }),
      runtimeFactory: async () => { throw new Error('runtime must remain lazy'); },
    });
    assert.equal(report.mode, 'read-only');
    assert.equal(report.preview.missing, 391);
    assert.equal(report.plan.estimated_scan_windows, '4');
    assert.equal(report.plan.estimated_concurrent_batches, '2');
  });

  it('validates bounded execution arguments', () => {
    assert.deepEqual(parseArgs([
      CONFIRM_FLAG, '--max-blocks=1000', '--max-operations=9', '--window-concurrency=4',
    ]), {
      confirm: true, retryFailed: false, maxBlocks: 1000, maxOperations: 9,
      pauseMs: 250, tokenBatchSize: 500, windowConcurrency: 4,
      addressFilterLimit: 500, maxAttempts: 20, retryMs: 60000,
    });
    assert.throws(() => parseArgs(['--retry-failed']), /requires confirmation/);
    assert.throws(() => parseArgs(['--window-concurrency=17']), /must be between/);
  });

  it('initializes, recovers and drains bounded shadow batches', async () => {
    const calls = [];
    let ranges = 0;
    const report = await main([
      CONFIRM_FLAG, '--max-operations=3', '--pause-ms=0',
    ], {
      database: {}, logger: { log() {} }, runtime: { tickDeps: {
        positions: {}, transactionPositions: {}, evidence: {},
      } },
      repositoryFactory: () => ({
        async initialize() { calls.push('initialize'); return { inserted: 391 }; },
        async recover() { calls.push('recover'); return { staleLeases: 2, failed: 0 }; },
        async plan() { return { candidates: 391 }; },
      }),
      async runRange() {
        ranges += 1;
        return ranges === 1
          ? { status: 'batch-projected', tokens: 391, windows: 8,
            positions: 20, complete: 4 }
          : { status: 'caught-up' };
      },
    });
    assert.deepEqual(calls, ['initialize', 'recover']);
    assert.equal(report.mode, 'apply-shadow');
    assert.equal(report.execution.operations, 2);
    assert.equal(report.execution.tokens, 391);
    assert.equal(report.execution.caughtUp, true);
  });

  it('retries transient control-plane database acquisition', async () => {
    let attempts = 0;
    const waits = [];
    const report = await main([], {
      database: {}, logger: { log() {}, error() {} },
      sleep: async (ms) => waits.push(ms),
      repositoryFactory: () => ({
        async preview() {
          attempts += 1;
          if (attempts === 1) throw new Error('timeout exceeded when trying to connect');
          return { eligible: 0, initialized: 0, missing: 0 };
        },
        async plan() { return { candidates: 0 }; },
      }),
    });
    assert.equal(report.mode, 'read-only');
    assert.equal(attempts, 2);
    assert.deepEqual(waits, [250]);
  });
});
