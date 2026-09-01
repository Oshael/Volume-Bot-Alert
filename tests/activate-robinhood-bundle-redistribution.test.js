const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  main, parseArgs,
} = require('../src/utils/activate-robinhood-bundle-redistribution');

describe('Robinhood BUNDLED redistribution activation command', () => {
  it('is read-only by default and bounds the future lead', () => {
    assert.deepEqual(parseArgs([]), { apply: false, leadBlocks: 1000 });
    assert.deepEqual(parseArgs(['--apply', '--lead-blocks=500']), {
      apply: true, leadBlocks: 500,
    });
    assert.throws(() => parseArgs(['--lead-blocks=99']), /between 100 and 100000/);
    assert.throws(() => parseArgs(['--apply', '--apply']), /unknown or repeated/);
    assert.throws(() => parseArgs(['--force']), /unknown or repeated/);
  });

  it('inspects without applying when confirmation is absent', async () => {
    const calls = [];
    const report = await main([], {
      control: {
        async inspect() { calls.push('inspect'); return { mode: 'read-only', ready: true }; },
        async apply() { throw new Error('unexpected write'); },
      },
      logger: { log: (line) => calls.push(JSON.parse(line)) },
    });
    assert.deepEqual(report, { mode: 'read-only', ready: true });
    assert.deepEqual(calls, ['inspect', report]);
  });

  it('passes the bounded lead to the idempotent apply operation', async () => {
    let input;
    const report = await main(['--apply', '--lead-blocks=250'], {
      control: {
        async inspect() { throw new Error('unexpected read path'); },
        async apply(value) {
          input = value;
          return { mode: 'apply', action: 'reserved', ready: false };
        },
      },
      logger: { log() {} },
    });
    assert.deepEqual(input, { leadBlocks: 250 });
    assert.equal(report.action, 'reserved');
  });
});
