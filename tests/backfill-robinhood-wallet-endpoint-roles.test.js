const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  CONFIRM_FLAG, buildRuntime, main, parseArgs,
} = require('../src/utils/backfill-robinhood-wallet-endpoint-roles');

describe('Robinhood wallet endpoint-role backfill command', () => {
  it('accepts only bounded arguments and a long confirmation flag', () => {
    assert.deepEqual(parseArgs([]), { confirm: false, limit: 100, batchSize: 50 });
    assert.deepEqual(parseArgs([CONFIRM_FLAG, '--limit=1000', '--batch-size=100']), {
      confirm: true, limit: 1000, batchSize: 100,
    });
    assert.throws(() => parseArgs(['--limit=0']), /between 1 and 1000/);
    assert.throws(() => parseArgs(['--commit']), /unknown argument/);
  });

  it('builds a runtime with only the explicitly configured PC archive node', async () => {
    const created = {};
    const runtime = await buildRuntime({ batchSize: 25 }, {
      env: { RH_NODE_RPC_URL: 'http://127.0.0.1:8547', DATABASE_URL: 'postgres://tunnel' },
      database: { query: async () => ({ rows: [{ events: 'events', roles: 'roles' }] }) },
      rpcClientFactory: (options) => {
        created.rpc = options;
        return { request: async () => '0x1237' };
      },
      repositoryFactory: (options) => { created.repository = options; return { name: 'repo' }; },
      readerFactory: (options) => { created.reader = options; return { name: 'reader' }; },
    });
    assert.deepEqual(created.rpc.providers, [{
      name: 'robinhood-pc-archive', url: 'http://127.0.0.1:8547',
    }]);
    assert.equal(created.reader.batchSize, 25);
    assert.equal(runtime.provider, 'robinhood-pc-archive');
    assert.equal(runtime.repository.name, 'repo');
  });

  it('is dry-run by default and writes only after explicit confirmation', async () => {
    const calls = [];
    const deps = {
      runtime: { provider: 'robinhood-pc-archive' },
      logger: { log: (value) => calls.push(['log', value]) },
      runBackfill: async (_runtime, input) => {
        calls.push(['run', input]);
        return { status: input.commit ? 'persisted' : 'dry-run' };
      },
    };
    assert.equal((await main(['--limit=5'], deps)).mode, 'dry-run');
    assert.deepEqual(calls.find(([kind]) => kind === 'run')[1], { limit: 5, commit: false });
    calls.length = 0;
    assert.equal((await main([CONFIRM_FLAG], deps)).mode, 'confirmed');
    assert.deepEqual(calls.find(([kind]) => kind === 'run')[1], { limit: 100, commit: true });
  });
});
