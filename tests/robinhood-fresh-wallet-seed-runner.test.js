const assert = require('node:assert/strict');
const { it } = require('node:test');
const {
  createArchiveSource, executeSeed, runPreflight,
} = require('../src/services/robinhood-fresh-wallet-seed-runner');
const { parseArgs } = require('../src/utils/backfill-robinhood-fresh-wallets');

const TASK = { tokenAddress: `0x${'a'.repeat(40)}`, walletAddress: `0x${'b'.repeat(40)}`,
  transactionHash: `0x${'c'.repeat(64)}`, blockNumber: '20',
  blockHash: `0x${'d'.repeat(64)}`, blockTime: '2026-08-22T12:00:00Z' };

it('samples Archive evidence and refuses a seed projected above five hours', async () => {
  const repository = { loadPlan: async () => ({ ready: true, pairCount: 100_000,
    tokenCount: 10 }), samplePairs: async () => [TASK] };
  const slow = await runPreflight({ repository, source: { readEvidence: async () => ({}) },
    now: (() => { const values = [0, 200]; return () => values.shift(); })(),
  }, { sampleCount: 1, concurrency: 1 });
  assert.equal(slow.projectedMs, 25_000_000);
  assert.equal(slow.approved, false);
  await assert.rejects(executeSeed({}, { preflight: slow }),
    (error) => error.code === 'fresh_seed_preflight_refused');

  const unavailable = await runPreflight({ repository,
    source: { readEvidence: async () => { throw new Error('no archive'); } },
    now: (() => { const values = [0, 1]; return () => values.shift(); })(),
  }, { sampleCount: 1 });
  assert.equal(unavailable.sampledUnavailable, 1);
  assert.equal(unavailable.approved, false);
});

it('drains the frozen queue with the shared rule and pauses resumable failures', async () => {
  let claimed = false; const retries = []; const sync = [];
  const repository = { createOrResume: async () => ({ runId: '7', status: 'running' }),
    async syncProgress(id, pause) { sync.push([id, pause]); return {
      runId: id, status: pause ? 'paused' : 'running', total: 1, completed: 0,
    }; } };
  const queue = { async claimBatch(input) {
    if (claimed) return []; claimed = true; assert.equal(input.sourceKind, 'seed'); return [TASK];
  }, async retry(input) { retries.push(input); } };
  const progress = await executeSeed({ repository, queue, shadow: {},
    source: { readEvidence: async () => { throw Object.assign(new Error('RPC down'), {
      code: 'rpc_unavailable',
    }); } }, now: () => 0,
  }, { preflight: { approved: true, concurrency: 1, pairCount: 1, tokenCount: 1 },
    maxMinutes: 1 });
  assert.equal(progress.status, 'paused');
  assert.equal(retries.length, 1);
  assert.deepEqual(sync, [['7', undefined], ['7', true]]);
});

it('uses only RH_NODE_RPC_URL and keeps CLI writes explicit', () => {
  let kind; let rpcOptions;
  createArchiveSource({}, { env: { RH_NODE_RPC_URL: 'http://archive' },
    providerResolver(env, value) { kind = value; return { name: 'archive',
      url: env.RH_NODE_RPC_URL }; },
    rpcClientFactory(options) { rpcOptions = options; return { request() {} }; },
    sourceFactory: (options) => options,
  });
  assert.equal(kind, 'archive');
  assert.equal(rpcOptions.publicRpcUrl, 'http://archive');
  assert.equal(rpcOptions.useAlchemy, false);
  assert.deepEqual(parseArgs(['--samples=5', '--concurrency=3']), {
    apply: false, sampleCount: 5, concurrency: 3, batchSize: 10,
    maxHours: 5, maxMinutes: 285, timeoutMs: 60_000,
  });
  assert.equal(parseArgs(['--apply']).apply, true);
  assert.throws(() => parseArgs(['--unknown=1']), /unexpected argument/);
});
