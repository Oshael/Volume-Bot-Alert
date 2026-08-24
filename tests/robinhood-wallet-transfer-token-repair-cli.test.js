const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  CONFIRM_FLAG, main, parseArgs,
} = require('../src/utils/repair-robinhood-wallet-transfer-tokens');

describe('Robinhood token-scoped transfer repair CLI', () => {
  it('is read-only by default and does not construct the archive runtime', async () => {
    const messages = [];
    const report = await main([], {
      database: {}, logger: { log: (message) => messages.push(message) },
      repositoryFactory: () => ({
        plan: async () => ({ candidates: 3, remaining_block_span: '900' }),
        getProgress: async () => ({ pending: 3 }),
      }),
      runtimeFactory: async () => { throw new Error('runtime must stay lazy'); },
    });
    assert.equal(report.mode, 'read-only');
    assert.equal(report.plan.candidates, 3);
    assert.equal(messages.length, 1);
  });

  it('bounds apply arguments and requires confirmation to retry failures', () => {
    assert.deepEqual(parseArgs([CONFIRM_FLAG, '--max-blocks=250', '--max-operations=8']), {
      confirm: true, retryFailed: false, maxBlocks: 250, maxOperations: 8, pauseMs: 250,
    });
    assert.throws(() => parseArgs(['--retry-failed']), /requires confirmation/);
    assert.throws(() => parseArgs(['--max-blocks=0']), /must be between/);
  });
});
