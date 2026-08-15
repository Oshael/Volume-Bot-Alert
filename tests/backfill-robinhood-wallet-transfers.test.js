const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  CONFIRM_FLAG, main, parseArgs,
} = require('../src/utils/backfill-robinhood-wallet-transfers');

function harness() {
  const calls = [];
  const deps = {
    options: { marker: 'options' }, now: '2099-01-01T00:00:00Z',
    logger: { log: (value) => calls.push({ method: 'log', value }) },
    runtimeFactory: async (options) => {
      calls.push({ method: 'runtime', options });
      return { providerChainIds: { primary: '4663' }, tickDeps: { marker: 'tick' } };
    },
    runDryRun: async (tickDeps, input) => {
      calls.push({ method: 'dry-run', tickDeps, input });
      return { status: 'dry-run' };
    },
    runCommit: async (tickDeps, input) => {
      calls.push({ method: 'commit', tickDeps, input });
      return { status: 'projected' };
    },
  };
  return { calls, deps };
}

describe('Robinhood wallet-transfer backfill command', () => {
  it('accepts only one bounded range and a long confirmation flag', () => {
    assert.deepEqual(parseArgs([]), { confirm: false, maxBlocks: 250 });
    assert.deepEqual(parseArgs(['--max-blocks=5000', CONFIRM_FLAG]), {
      confirm: true, maxBlocks: 5000,
    });
    assert.throws(() => parseArgs(['--max-blocks=0']), /between 1 and 5000/);
    assert.throws(() => parseArgs(['--max-blocks=2', '--max-blocks=3']), /cannot be repeated/);
    assert.throws(() => parseArgs(['--commit']), /unknown argument/);
  });

  it('is dry-run by default and validates the runtime before executing', async () => {
    const test = harness();
    const report = await main(['--max-blocks=20'], test.deps);
    assert.equal(report.mode, 'dry-run');
    assert.equal(test.calls.some(({ method }) => method === 'commit'), false);
    assert.deepEqual(test.calls.find(({ method }) => method === 'dry-run'), {
      method: 'dry-run', tickDeps: { marker: 'tick' },
      input: { maxBlocks: 20, now: '2099-01-01T00:00:00Z' },
    });
    assert.equal(test.calls.filter(({ method }) => method === 'log').length, 2);
  });

  it('commits exactly one range only with the explicit confirmation', async () => {
    const test = harness();
    const report = await main([CONFIRM_FLAG], test.deps);
    assert.equal(report.mode, 'commit-one-range');
    assert.equal(report.result.status, 'projected');
    assert.equal(test.calls.filter(({ method }) => method === 'commit').length, 1);
    assert.equal(test.calls.some(({ method }) => method === 'dry-run'), false);
    assert.equal(test.calls.filter(({ method }) => method === 'log').length, 1);
  });
});
