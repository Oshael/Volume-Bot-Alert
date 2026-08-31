const assert = require('node:assert/strict');
const { it } = require('node:test');
const {
  createArchiveSource, executeSeed, runPreflight,
} = require('../src/services/robinhood-fresh-wallet-seed-runner');
const {
  createRobinhoodFreshWalletSeedRepository,
} = require('../src/models/robinhood-fresh-wallet-seed');
const { parseArgs } = require('../src/utils/backfill-robinhood-fresh-wallets');

const TASK = { tokenAddress: `0x${'a'.repeat(40)}`, walletAddress: `0x${'b'.repeat(40)}`,
  transactionHash: `0x${'c'.repeat(64)}`, blockNumber: '20',
  blockHash: `0x${'d'.repeat(64)}`, blockTime: '2026-08-22T12:00:00Z' };
const SEED_EVIDENCE = { ruleVersion: 'rh_fresh_signed_v1', sourceKind: 'seed',
  source: 'archive', observedAt: '2026-08-22T12:03:00Z', firstBuy: {
    walletAddress: TASK.walletAddress, transactionHash: TASK.transactionHash,
    blockNumber: TASK.blockNumber, blockHash: TASK.blockHash,
    blockTime: TASK.blockTime, nonce: '5',
  }, cutoff: { targetAt: '2026-08-21T12:00:00Z', number: '10',
    hash: TASK.blockHash, blockTime: '2026-08-21T11:59:59Z', nonce: '0' },
  nextBlock: { number: '11', hash: TASK.blockHash, blockTime: '2026-08-21T12:00:00Z' } };

it('keeps projected duration advisory and refuses only unavailable Archive evidence', async () => {
  const repository = { loadPlan: async () => ({ ready: true, pairCount: 100_000,
    tokenCount: 10 }), samplePairs: async () => [TASK] };
  const slow = await runPreflight({ repository, source: { readEvidence: async () => ({}) },
    now: (() => { const values = [0, 200]; return () => values.shift(); })(),
  }, { sampleCount: 1, concurrency: 1 });
  assert.equal(slow.projectedMs, 25_000_000);
  assert.equal(slow.durationAdvisoryExceeded, true);
  assert.equal(slow.approved, true);

  const unavailable = await runPreflight({ repository,
    source: { readEvidence: async () => { throw new Error('no archive'); } },
    now: (() => { const values = [0, 1]; return () => values.shift(); })(),
  }, { sampleCount: 1 });
  assert.equal(unavailable.sampledUnavailable, 1);
  assert.equal(unavailable.approved, false);
  await assert.rejects(executeSeed({}, { preflight: unavailable }),
    (error) => error.code === 'fresh_seed_preflight_refused');

  const empty = await runPreflight({ repository: {
    loadPlan: async () => ({ ready: true, tokenCount: 0, pairCount: 0 }),
    samplePairs: async () => { throw new Error('empty cohort must not sample'); },
  } });
  assert.equal(empty.approved, false);
});

it('allows an explicit 24-hour preflight without changing the five-hour default', async () => {
  const repository = { loadPlan: async () => ({ ready: true, pairCount: 100_000,
    tokenCount: 10 }), samplePairs: async () => [TASK] };
  const timed = (elapsedMs, maxHours = 24) => runPreflight({ repository,
    source: { readEvidence: async () => ({}) },
    now: (() => { const values = [0, elapsedMs]; return () => values.shift(); })(),
  }, { sampleCount: 1, batchSize: 1, concurrency: 1, maxHours });
  assert.equal((await timed(200)).approved, true);
  await assert.rejects(() => timed(200, 25), /at most 24/);
});

it('allows one explicit 24-hour execution session', async () => {
  const deps = { repository: {
    createOrResume: async () => ({ runId: '9', status: 'completed' }),
    syncProgress: async () => ({ runId: '9', status: 'completed' }),
  }, queue: { claimBatch() {} }, shadow: {} };
  const options = { preflight: { approved: true, concurrency: 1 }, maxMinutes: 1440 };
  assert.equal((await executeSeed(deps, options)).status, 'completed');
  await assert.rejects(() => executeSeed(deps, { ...options, maxMinutes: 1441 }),
    /between 1 and 1440/);
});

it('measures batched Archive throughput when the source supports it', async () => {
  let batchCalls = 0;
  const repository = { loadPlan: async () => ({ ready: true, pairCount: 100,
    tokenCount: 10 }), samplePairs: async () => [TASK, TASK] };
  const result = await runPreflight({ repository, source: {
    async readEvidenceBatch(items) { batchCalls += 1; return items.map(() => ({})); },
    async readEvidence() { throw new Error('individual RPC path must not run'); },
  }, now: (() => { const values = [0, 10]; return () => values.shift(); })() },
  { sampleCount: 2, concurrency: 2 });
  assert.equal(batchCalls, 1);
  assert.equal(result.sampledUnavailable, 0);
  assert.equal(result.projectedMs, 625);
});

it('samples at least one complete execution batch for a representative projection', async () => {
  let requestedSamples;
  const samples = Array.from({ length: 100 }, () => TASK);
  const repository = { loadPlan: async () => ({ ready: true, pairCount: 100,
    tokenCount: 10 }), samplePairs: async (limit) => {
    requestedSamples = limit; return samples;
  } };
  const result = await runPreflight({ repository, source: {
    readEvidenceBatch: async (items) => items.map(() => ({})),
  }, now: (() => { const values = [0, 10]; return () => values.shift(); })() },
  { sampleCount: 64, batchSize: 100, concurrency: 16 });
  assert.equal(requestedSamples, 100);
  assert.equal(result.sampleCount, 100);
  assert.equal(result.batchSize, 100);
});

it('allows the seed repository to return a complete 100-pair sample', async () => {
  const limits = [];
  const database = { async query(sql, params) {
    if (sql.includes('SELECT id, status FROM robinhood_fresh_wallet_seed_runs')) {
      return { rows: [] };
    }
    limits.push(params[2]);
    return { rows: [] };
  } };
  const repository = createRobinhoodFreshWalletSeedRepository({ database });
  await repository.samplePairs(100);
  assert.deepEqual(limits, [100]);
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
    source: { readEvidence: async () => { throw new Error('individual RPC path must not run'); },
      readEvidenceBatch: async () => { throw Object.assign(new Error('RPC down'), {
      code: 'rpc_unavailable',
    }); } }, now: () => 0,
  }, { preflight: { approved: true, concurrency: 1, pairCount: 1, tokenCount: 1 },
    maxMinutes: 1 });
  assert.equal(progress.status, 'paused');
  assert.equal(retries.length, 1);
  assert.deepEqual(sync, [['7', true]]);
});

it('drains successful seed evidence through the set-based materializer', async () => {
  let claimed = false; let batchCalls = 0;
  const repository = { createOrResume: async () => ({ runId: '8', status: 'running' }),
    syncProgress: async () => ({ runId: '8', status: 'completed', total: 1, completed: 1 }) };
  const queue = { async claimBatch() {
    if (claimed) return []; claimed = true;
    return [{ ...TASK, sourceKind: 'seed', requestedVersion: '1' }];
  }, async retry() { throw new Error('successful batch must not retry'); } };
  const shadow = { async replaceAndCompleteBatch(inputs) {
    batchCalls += 1; assert.equal(inputs.length, 1); return [{ completed: true, status: 'replace' }];
  } };
  const result = await executeSeed({ repository, queue, shadow,
    source: { sourceKind: 'seed', readEvidenceBatch: async () => [SEED_EVIDENCE] }, now: () => 0,
  }, { preflight: { approved: true, concurrency: 1 }, batchSize: 100, maxMinutes: 1 });
  assert.equal(result.status, 'completed');
  assert.equal(batchCalls, 1);
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
