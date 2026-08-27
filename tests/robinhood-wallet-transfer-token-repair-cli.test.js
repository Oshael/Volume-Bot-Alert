const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  CONFIRM_FLAG, main, parseArgs,
} = require('../src/utils/repair-robinhood-wallet-transfer-tokens');

describe('Robinhood token-scoped transfer repair CLI', () => {
  it('is read-only by default and does not construct the archive runtime', async () => {
    const messages = [];
    const report = await main(['--max-blocks=250', '--window-concurrency=2'], {
      database: {}, logger: { log: (message) => messages.push(message) },
      repositoryFactory: () => ({
        plan: async () => ({
          candidates: 3, pending: 3, shadow_complete: 0, leased: 0, failed: 0,
          remaining_block_span: '900', earliest_source_block: '100', latest_source_block: '999',
        }),
        getProgress: async () => ({ pending: 3 }),
      }),
      runtimeFactory: async () => { throw new Error('runtime must stay lazy'); },
    });
    assert.equal(report.mode, 'read-only');
    assert.equal(report.plan.candidates, 3);
    assert.equal(report.plan.sharedWindowBlockSpan, '900');
    assert.equal(report.plan.estimatedScanOperations, '4');
    assert.equal(report.plan.estimatedConcurrentScanBatches, '2');
    assert.equal(report.plan.estimatedTotalOperations, '5');
    assert.equal(messages.length, 1);
  });

  it('bounds apply arguments and requires confirmation to retry failures', () => {
    assert.deepEqual(parseArgs([CONFIRM_FLAG, '--max-blocks=250', '--max-operations=8']), {
      confirm: true, retryFailed: false, maxBlocks: 250, maxOperations: 8, pauseMs: 250,
      tokenBatchSize: 500, windowConcurrency: 1, addressFilterLimit: 100,
    });
    assert.throws(() => parseArgs(['--retry-failed']), /requires confirmation/);
    assert.throws(() => parseArgs(['--max-blocks=0']), /must be between/);
  });

  it('retries transient control-plane connection acquisition without ending the repair', async () => {
    const waits = [];
    const logs = [];
    let promotionAttempts = 0;
    let runtimeAttempts = 0;
    const report = await main([CONFIRM_FLAG, '--max-operations=1'], {
      database: {},
      logger: { log() {}, error: (message) => logs.push(message) },
      sleep: async (ms) => { waits.push(ms); },
      repositoryFactory: () => ({
        async plan() { return { candidates: 1, pending: 1 }; },
        async initialize() { return { inserted: 0 }; },
        async recover() { return { staleLeases: 0, failed: 0 }; },
        async promoteNext() {
          promotionAttempts += 1;
          if (promotionAttempts === 1) {
            throw new Error('Connection terminated due to connection timeout');
          }
          return null;
        },
        async getProgress() { return { pending: 0, published: 1 }; },
      }),
      runtimeFactory: async () => {
        runtimeAttempts += 1;
        if (runtimeAttempts === 1) {
          throw new Error('timeout exceeded when trying to connect');
        }
        return { tickDeps: {} };
      },
      runRange: async () => ({ status: 'caught-up' }),
    });

    assert.equal(report.mode, 'apply');
    assert.equal(promotionAttempts, 2);
    assert.equal(runtimeAttempts, 2);
    assert.deepEqual(waits, [250, 250]);
    assert.match(logs[0], /DB acquisition retry operation=promoteNext attempt=1/);
    assert.match(logs[1], /DB acquisition retry operation=buildRuntime attempt=1/);
  });
});
