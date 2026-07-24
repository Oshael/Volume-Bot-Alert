const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodBackfillEnrichmentWorker,
} = require('../src/services/robinhood-backfill-enrichment-worker');

const TX = `0x${'a'.repeat(64)}`;
const TOKEN = `0x${'b'.repeat(40)}`;

function claim(overrides = {}) {
  return {
    transactionHash: overrides.transactionHash || TX,
    logIndex: overrides.logIndex ?? '1',
    blockNumber: overrides.blockNumber || '16',
    attemptCount: overrides.attemptCount || 1,
  };
}

function entryFor(input) {
  return {
    log: {
      transactionHash: input.claim.transactionHash,
      logIndex: input.claim.logIndex,
      blockNumber: input.claim.blockNumber,
    },
    event: { kind: 'swap' },
    observation: input.results.accepted,
  };
}

function createHarness(options = {}) {
  const calls = [];
  const claims = options.claims || [claim()];
  const captureRepository = {
    async claimEnrichmentBatch(input) {
      calls.push({ method: 'claim', input });
      return claims;
    },
    async renewEnrichmentClaims(input) {
      calls.push({ method: 'renew', input });
      return options.renewedClaims ?? claims;
    },
    async failEnrichmentClaims(input) {
      calls.push({ method: 'fail', input });
      return options.failedClaims || claims.map((item) => ({ ...item, status: 'pending' }));
    },
  };
  const persistenceRepository = {
    async commitBackfillEnrichmentBatch(input) {
      calls.push({ method: 'commit', input });
      return {
        insertedLogs: input.entries.length,
        insertedObservations: input.entries.length,
        aggregationTargets: input.entries.length,
        terminalClaims: input.claims.length,
      };
    },
  };
  const adapter = {
    async prepareClaim(item) {
      calls.push({ method: 'prepare', claim: item });
      return {
        tokenAddress: TOKEN,
        requests: [{
          slot: 'accepted',
          provider: 'drpc',
          method: 'eth_call',
          params: [{ to: TOKEN, data: '0x01' }, '0x10'],
        }],
        context: { decoded: true },
      };
    },
    async buildEntry(input) {
      calls.push({ method: 'build', input });
      return entryFor(input);
    },
  };
  const rpcClient = {
    async request() {
      throw new Error('default provider must not be used');
    },
    async requestProvider(provider, method, params) {
      calls.push({ method: 'rpc', provider, rpcMethod: method, params });
      if (options.rpcError) throw options.rpcError;
      return options.observation || { accepted: true };
    },
  };
  return {
    calls,
    createWorker(overrides = {}) {
      return createRobinhoodBackfillEnrichmentWorker({
        adapter,
        captureRepository,
        persistenceRepository,
        rpcClient,
        ...overrides,
      });
    },
  };
}

describe('Robinhood backfill enrichment worker', () => {
  it('claims, executes the planner and atomically commits terminal entries', async () => {
    const harness = createHarness();
    const worker = harness.createWorker();
    const result = await worker.runOnce({
      owner: 'worker-a',
      leaseMs: 10_000,
      renewalIntervalMs: 5_000,
      useBatch: false,
    });

    assert.deepEqual(result, {
      status: 'completed',
      claimed: 1,
      rpc: {
        batches: 0,
        batchItems: 0,
        individualRequests: 1,
        batchFallbacks: 0,
      },
      insertedLogs: 1,
      insertedObservations: 1,
      aggregationTargets: 1,
      terminalClaims: 1,
    });
    assert.deepEqual(
      harness.calls.map(({ method }) => method),
      ['claim', 'prepare', 'rpc', 'build', 'commit']
    );
    const commit = harness.calls.find(({ method }) => method === 'commit').input;
    assert.equal(commit.owner, 'worker-a');
    assert.deepEqual(commit.claims, [claim()]);
    assert.equal(commit.entries[0].observation.accepted, true);
    assert.equal(worker.getStatus().totals.completed, 1);
  });

  it('returns idle without creating RPC work when the durable queue is empty', async () => {
    const harness = createHarness({ claims: [] });
    const worker = harness.createWorker();

    assert.deepEqual(await worker.runOnce({ owner: 'worker-a' }), {
      status: 'idle',
      claimed: 0,
    });
    assert.deepEqual(harness.calls.map(({ method }) => method), ['claim']);
    assert.equal(worker.getStatus().totals.idle, 1);
  });

  it('returns recoverable RPC failures to cooldown without committing', async () => {
    const rpcError = Object.assign(new Error('provider timed out'), {
      code: 'timeout',
      retryable: true,
    });
    const harness = createHarness({ rpcError });
    const worker = harness.createWorker();

    await assert.rejects(
      worker.runOnce({
        owner: 'worker-a',
        retryDelayMs: 12_000,
        maxAttempts: 4,
        useBatch: false,
      }),
      (error) => error === rpcError
    );
    assert.deepEqual(
      harness.calls.map(({ method }) => method),
      ['claim', 'prepare', 'rpc', 'fail']
    );
    const failure = harness.calls.find(({ method }) => method === 'fail').input;
    assert.equal(failure.retryDelayMs, 12_000);
    assert.equal(failure.maxAttempts, 4);
    assert.equal(failure.error, 'provider timed out');
    assert.equal(worker.getStatus().totals.retries, 1);
  });

  it('commits a business rejection instead of returning it to cooldown', async () => {
    const harness = createHarness({
      observation: { accepted: false, reason: 'token_ineligible' },
    });
    const worker = harness.createWorker();
    await worker.runOnce({ owner: 'worker-a', useBatch: false });

    assert.equal(harness.calls.some(({ method }) => method === 'commit'), true);
    assert.equal(harness.calls.some(({ method }) => method === 'fail'), false);
    assert.equal(worker.getStatus().totals.rejected, 1);
  });

  it('blocks commit when a heartbeat detects a lost lease', async () => {
    let heartbeatTick;
    let releaseRpc;
    const rpcStarted = new Promise((resolve) => {
      releaseRpc = resolve;
    });
    const harness = createHarness({ renewedClaims: [] });
    const worker = harness.createWorker({
      scheduleHeartbeat(callback) {
        heartbeatTick = callback;
        return 'heartbeat';
      },
      cancelHeartbeat() {},
      rpcClient: {
        request() {},
        async requestProvider() {
          await rpcStarted;
          return { accepted: true };
        },
      },
    });
    const running = worker.runOnce({
      owner: 'worker-a',
      leaseMs: 10_000,
      renewalIntervalMs: 100,
      useBatch: false,
    });
    await new Promise((resolve) => setImmediate(resolve));
    heartbeatTick();
    await new Promise((resolve) => setImmediate(resolve));
    releaseRpc();

    await assert.rejects(running, (error) => error.code === 'backfill_claim_lost');
    assert.equal(harness.calls.some(({ method }) => method === 'renew'), true);
    assert.equal(harness.calls.some(({ method }) => method === 'commit'), false);
    assert.equal(harness.calls.some(({ method }) => method === 'fail'), false);
  });

  it('rejects an overlapping run without issuing a second claim', async () => {
    let releaseClaim;
    const claimGate = new Promise((resolve) => {
      releaseClaim = resolve;
    });
    const harness = createHarness();
    const worker = harness.createWorker({
      captureRepository: {
        async claimEnrichmentBatch(input) {
          harness.calls.push({ method: 'claim', input });
          await claimGate;
          return [];
        },
      },
    });
    const first = worker.runOnce({ owner: 'worker-a' });
    assert.deepEqual(await worker.runOnce({ owner: 'worker-a' }), { status: 'busy' });
    releaseClaim();
    await first;
    assert.equal(harness.calls.filter(({ method }) => method === 'claim').length, 1);
  });
});
