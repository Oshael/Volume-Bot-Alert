const assert = require('node:assert/strict');
const { it } = require('node:test');
const {
  createRobinhoodFreshWalletLiveWorker, processTask,
  __private: { buildRuntime },
} = require('../src/services/robinhood-fresh-wallet-live-worker');

const TOKEN = `0x${'a'.repeat(40)}`;
const HASH = `0x${'b'.repeat(64)}`;
const TX = `0x${'c'.repeat(64)}`;
const wallet = (digit) => `0x${digit.repeat(40)}`;

function evidence(walletAddress, nonce = '6') {
  return {
    ruleVersion: 'rh_fresh_signed_v1', source: 'robinhood-live',
    observedAt: '2026-08-22T12:03:00Z',
    firstBuy: { walletAddress, transactionHash: TX, blockNumber: '21', blockHash: HASH,
      blockTime: '2026-08-22T12:02:00Z', nonce },
    cutoff: { targetAt: '2026-08-21T12:02:00Z', number: '10', hash: HASH,
      blockTime: '2026-08-21T12:01:59Z', nonce: '0' },
    nextBlock: { number: '11', hash: HASH, blockTime: '2026-08-21T12:02:00Z' },
  };
}

it('evaluates RPC evidence and atomically completes a not-fresh shadow task', async () => {
  let persisted;
  const task = { tokenAddress: TOKEN, walletAddress: wallet('1'), requestedVersion: '2',
    owner: 'test' };
  const result = await processTask({
    source: { readEvidence: async () => evidence(task.walletAddress) },
    shadow: { replaceAndComplete: async (...args) => { persisted = args; return { completed: true }; } },
  }, task);
  assert.deepEqual(result, { status: 'materialized', tokenAddress: TOKEN,
    walletAddress: task.walletAddress, outcome: 'not_fresh' });
  assert.equal(persisted[0].decision.outcomeReason, 'too_many_prior_signed_transactions');
  assert.equal(persisted[1].allowForkReplacement, true);
});

it('bounds concurrency, retries independently and opens its RPC circuit', async () => {
  const tasks = ['1', '2', '3'].map((digit) => ({ tokenAddress: TOKEN,
    walletAddress: wallet(digit), requestedVersion: '1', attemptCount: 1 }));
  let claims = 0; let active = 0; let maxActive = 0; const retries = [];
  const runtime = {
    queue: { async claimBatch() { claims += 1; return tasks; },
      async retry(input) { retries.push(input); } },
    source: { async readEvidence() {
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve)); active -= 1;
      throw Object.assign(new Error('RPC down'), { code: 'rpc_unavailable' });
    } }, shadow: {},
  };
  const scheduled = [];
  const worker = createRobinhoodFreshWalletLiveWorker({
    runtime, owner: 'test', now: () => Date.parse('2026-08-22T12:00:00Z'),
    schedule(fn, delay) { const item = { fn, delay }; scheduled.push(item); return item; },
    cancelSchedule() {}, listenerFactory: () => ({ start() {}, stop() {} }),
  });
  worker.start({ enabled: true, batchSize: 3, concurrency: 2,
    circuitFailureThreshold: 2, circuitResetMs: 60_000 });
  assert.equal((await worker.runOnce()).status, 'partial');
  await worker.runOnce();
  assert.equal((await worker.runOnce()).status, 'circuit_open');
  assert.equal(claims, 2);
  assert.equal(maxActive, 2);
  assert.equal(retries.length, 6);
  assert.deepEqual({ totalClaimed: worker.getStatus().totalClaimed,
    totalDeferred: worker.getStatus().totalDeferred,
    circuitOpen: worker.getStatus().circuitOpen }, {
    totalClaimed: 6, totalDeferred: 6, circuitOpen: true,
  });
  await worker.stop();
});

it('builds only against the configured live provider', () => {
  let providerKind; let rpcOptions;
  buildRuntime({ database: {}, env: { ROBINHOOD_RPC_URL: 'https://live.example' },
    providerResolver(env, kind) { providerKind = kind; return { name: 'live-test', url: env.ROBINHOOD_RPC_URL }; },
    rpcClientFactory(options) { rpcOptions = options; return { request() {} }; },
    queueFactory: () => ({}), shadowFactory: () => ({}), sourceFactory: (options) => options,
  }, { timeoutMs: 12_000, rpcOptions: { rpcMaxRetries: 2 } });
  assert.equal(providerKind, 'live');
  assert.deepEqual(rpcOptions, {
    rpcMaxRetries: 2, publicRpcUrl: 'https://live.example', rpcTimeoutMs: 12_000,
  });
});
