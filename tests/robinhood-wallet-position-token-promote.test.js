const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  CONFIRM_FLAG, main, parseArgs,
} = require('../src/utils/promote-robinhood-wallet-positions');

describe('Robinhood token-scoped position promotion CLI', () => {
  it('is read-only by default', async () => {
    let mutations = 0;
    const report = await main([], {
      database: {}, logger: { log() {} }, repositoryFactory: () => ({
        async promotionPlan() { return { readyToPrepare: false, reasons: ['writers'] }; },
        async preparePromotion() { mutations += 1; },
      }),
    });
    assert.equal(report.mode, 'read-only');
    assert.equal(mutations, 0);
  });

  it('extends the frozen frontier before allowing promotion', async () => {
    let promoted = 0;
    const report = await main([CONFIRM_FLAG], {
      database: {}, logger: { log() {} }, repositoryFactory: () => ({
        async promotionPlan() { return { pending: 2 }; },
        async preparePromotion() {
          return { extended: 391, frontier: { block: '400', hash: `0x${'a'.repeat(64)}` } };
        },
        async promoteNext() { promoted += 1; },
      }),
    });
    assert.equal(report.status, 'shadow-catchup-required');
    assert.equal(promoted, 0);
  });

  it('promotes bounded tokens and is resumable', async () => {
    let remaining = 2;
    const report = await main([CONFIRM_FLAG, '--max-tokens=10'], {
      database: {}, logger: { log() {} }, repositoryFactory: () => ({
        async promotionPlan() { return { published: 2, readyToPromote: true }; },
        async preparePromotion() {
          return { extended: 0, frontier: { block: '400', hash: `0x${'a'.repeat(64)}` } };
        },
        async promoteNext() {
          if (!remaining) return null;
          remaining -= 1;
          return { removed: 3, promoted: 4 };
        },
      }),
    });
    assert.equal(report.tokens, 2);
    assert.equal(report.removed, 6);
    assert.equal(report.promoted, 8);
  });

  it('validates token bounds', () => {
    assert.deepEqual(parseArgs([CONFIRM_FLAG, '--max-tokens=25']), {
      confirm: true, maxTokens: 25,
    });
    assert.throws(() => parseArgs(['--max-tokens=0']), /between 1 and 500/);
  });
});
