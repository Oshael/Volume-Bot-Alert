const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  CONFIRM_FLAG, buildRuntime, main, parseArgs,
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
    runBackfill: async (input, runnerDeps) => {
      calls.push({ method: 'backfill', input, runnerDeps });
      return { status: 'range-limit', rangesCompleted: input.maxRanges };
    },
  };
  return { calls, deps };
}

describe('Robinhood wallet-transfer backfill command', () => {
  it('accepts only one bounded range and a long confirmation flag', () => {
    assert.deepEqual(parseArgs([]), {
      confirm: false, maxBlocks: 250, maxRanges: 1, pauseMs: 250,
    });
    assert.deepEqual(parseArgs([
      '--max-blocks=5000', '--max-ranges=20', '--pause-ms=1000', CONFIRM_FLAG,
    ]), {
      confirm: true, maxBlocks: 5000, maxRanges: 20, pauseMs: 1000,
    });
    assert.throws(() => parseArgs(['--max-blocks=0']), /between 1 and 5000/);
    assert.throws(() => parseArgs(['--max-blocks=2', '--max-blocks=3']), /cannot be repeated/);
    assert.throws(() => parseArgs(['--max-ranges=2']), /require the confirmation flag/);
    assert.throws(() => parseArgs(['--commit']), /unknown argument/);
  });

  it('builds transfer capture and role hydration on only the PC archive RPC', async () => {
    const created = {};
    const rpcClient = { marker: 'archive-client' };
    const runtime = await buildRuntime({ endpointRoleBatchSize: 25 }, {
      env: { RH_NODE_RPC_URL: 'http://127.0.0.1:8547', DATABASE_URL: 'postgres://tunnel' },
      database: { query: async () => ({ rows: [{ roles: 'roles' }] }) },
      rpcClientFactory: (options) => { created.rpc = options; return rpcClient; },
      transferRuntimeFactory: async (_options, deps) => {
        assert.equal(deps.rpcClient, rpcClient);
        return { providerChainIds: { 'robinhood-pc-archive': '4663' }, tickDeps: { base: true } };
      },
      roleRepositoryFactory: () => ({ marker: 'repository' }),
      roleReaderFactory: (options) => { created.reader = options; return { marker: 'reader' }; },
      hydratorFactory: (deps) => { created.hydrator = deps; return { hydrate: async () => ({}) }; },
    });
    assert.deepEqual(created.rpc.providers, [{
      name: 'robinhood-pc-archive', url: 'http://127.0.0.1:8547',
      minRequestIntervalMs: undefined,
    }]);
    assert.equal(created.reader.rpcClient, rpcClient);
    assert.equal(created.reader.batchSize, 25);
    assert.deepEqual(created.hydrator, {
      repository: { marker: 'repository' }, reader: { marker: 'reader' },
    });
    assert.equal(typeof runtime.tickDeps.endpointRoles.hydrate, 'function');
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

  it('runs a bounded leased backfill only with the explicit confirmation', async () => {
    const test = harness();
    const report = await main([CONFIRM_FLAG, '--max-ranges=3'], test.deps);
    assert.equal(report.mode, 'commit-bounded-ranges');
    assert.equal(report.result.status, 'range-limit');
    const call = test.calls.find(({ method }) => method === 'backfill');
    assert.deepEqual(call.input, {
      maxBlocks: 250, maxRanges: 3, pauseMs: 250, now: test.deps.now,
    });
    assert.equal(test.calls.some(({ method }) => method === 'dry-run'), false);
    assert.equal(test.calls.filter(({ method }) => method === 'log').length, 1);
  });
});
