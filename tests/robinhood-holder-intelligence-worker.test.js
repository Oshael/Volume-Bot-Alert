const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodHolderIntelligenceWorker,
} = require('../src/services/robinhood-holder-intelligence-worker');
const {
  createRobinhoodHolderIntelligenceCandidateRepository,
} = require('../src/models/robinhood-holder-intelligence-candidate');
const { createHolderIntelligenceRetry } = require('../src/services/robinhood-holder-intelligence-retry');

const TOKEN_A = `0x${'1'.repeat(40)}`;
const TOKEN_B = `0x${'2'.repeat(40)}`;

function harness(overrides = {}) {
  const calls = [];
  const outcomes = overrides.outcomes || [
    [{ status: 'published' }, { status: 'unchanged' }],
    [{ status: 'deferred' }, { status: 'published' }],
    [new Error('dev source failed'), { status: 'published' }],
  ];
  const materializers = outcomes.map((values, materializerIndex) => ({
    materializeToken: async (tokenAddress) => {
      calls.push([materializerIndex, tokenAddress]);
      const tokenIndex = tokenAddress === TOKEN_A ? 0 : 1;
      const outcome = values[tokenIndex];
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  }));
  return {
    calls,
    worker: createRobinhoodHolderIntelligenceWorker({
      candidates: {
        listCandidates: async (input) => {
          calls.push(['candidates', input]);
          if (overrides.candidateError) throw overrides.candidateError;
          return [TOKEN_A, TOKEN_B];
        },
      },
      materializers,
      logger: { warn: (...args) => calls.push(['warn', ...args]) },
      schedule: overrides.schedule,
      cancelSchedule: () => {},
    }),
  };
}

describe('Robinhood holder intelligence worker', () => {
  it('materializes every deterministic classifier with bounded candidates', async () => {
    const { calls, worker } = harness();

    assert.equal(worker.start({ enabled: false }), false);
    const result = await worker.runOnce();

    assert.deepEqual(result, { candidates: 2, completed: 4, deferred: 1, failed: 1 });
    assert.deepEqual(calls[0], ['candidates', {
      limit: 20, unavailableRetryMs: 3_600_000, afterToken: null,
    }]);
    assert.equal(calls.filter(([index]) => Number.isInteger(index)).length, 6);
    assert.equal(worker.getStatus().totalFailed, 1);
  });

  it('coalesces concurrent ticks and contains candidate lookup failures', async () => {
    let resolveCandidates;
    const gate = new Promise((resolve) => { resolveCandidates = resolve; });
    const context = harness({
      candidateError: Object.assign(new Error('query failed'), { code: 'db_error' }),
    });
    context.worker = createRobinhoodHolderIntelligenceWorker({
      candidates: { listCandidates: async () => { await gate; throw new Error('query failed'); } },
      materializers: [{ materializeToken: async () => ({ status: 'published' }) }],
      logger: { warn: () => {} },
    });

    const first = context.worker.runOnce();
    const second = context.worker.runOnce();
    resolveCandidates();

    assert.equal(await first, null);
    assert.equal(await second, null);
    assert.equal(context.worker.getStatus().totalRuns, 1);
    assert.equal(context.worker.getStatus().consecutiveErrors, 1);
  });

  it('bounds runtime options before scheduling', async () => {
    const scheduled = [];
    const { worker } = harness({ schedule: (_callback, delay) => scheduled.push(delay) });

    assert.equal(worker.start({ enabled: true, intervalMs: 10_000 }), true);
    assert.deepEqual(scheduled, [0]);
    await worker.stop();
    assert.throws(() => worker.start({ enabled: true, batchSize: 101 }), /batchSize/);
  });

  it('reports partial failures and applies token retry without delaying the whole loop', async () => {
    let clock = 0;
    const attempts = [];
    const worker = createRobinhoodHolderIntelligenceWorker({
      now: () => clock,
      candidates: { listCandidates: async () => [TOKEN_A, TOKEN_B] },
      materializers: [{ async materializeToken(token) {
        attempts.push(token);
        if (token === TOKEN_A) throw Object.assign(new Error('unanchored'), { code: 'fence' });
        return { status: 'unchanged' };
      } }],
    });
    await worker.runOnce();
    assert.equal(worker.getStatus().lastError.code, 'fence');
    assert.equal(worker.getStatus().consecutiveErrors, 0);
    await worker.runOnce();
    assert.deepEqual(attempts, [TOKEN_A, TOKEN_B]);
    clock = 120_000;
    await worker.runOnce();
    assert.deepEqual(attempts, [TOKEN_A, TOKEN_B, TOKEN_A]);
    clock = 359_999;
    await worker.runOnce();
    assert.equal(attempts.length, 3, 'second failure must increase the token backoff');
    clock = 360_000;
    await worker.runOnce();
    assert.equal(attempts.length, 4);
    clock = 3_600_000;
    await worker.runOnce();
    assert.ok(attempts.filter((token) => token === TOKEN_B).length === 2);
  });
});

describe('Robinhood holder intelligence candidates', () => {
  it('selects a bounded durable batch using the current classification version', async () => {
    const calls = [];
    const repository = createRobinhoodHolderIntelligenceCandidateRepository({
      database: { query: async (...args) => {
        calls.push(args);
        return { rows: [{ candidates: [TOKEN_A, TOKEN_B].map((tokenAddress) => ({ tokenAddress })),
          scanned: 2, unanchored: 0, next_token: TOKEN_B }] };
      } },
    });

    const result = await repository.listCandidates({ limit: 2, unavailableRetryMs: 60_000 });

    assert.deepEqual(result, [TOKEN_A, TOKEN_B]);
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(calls[0][1], ['rh_holder_v1', 60_000, 2, '', 10]);
    assert.match(calls[0][0], /ledger_status = 'live'/);
    assert.match(calls[0][0], /top10\.metric = 'top10'/);
    assert.match(calls[0][0], /top50\.metric = 'top50'/);
    await assert.rejects(repository.listCandidates({ limit: 101 }), /candidate limit/);
  });
});

it('bounds retry memory and releases deferred work at the normal interval', () => {
  let clock = 0;
  const retry = createHolderIntelligenceRetry({ now: () => clock, maxEntries: 2 });
  const options = { intervalMs: 10_000, maxErrorBackoffMs: 300_000,
    unavailableRetryMs: 3_600_000 };
  const candidate = (tokenAddress) => ({ tokenAddress, throughBlockNumber: '100',
    throughBlockHash: `0x${'a'.repeat(64)}` });
  const deferred = [{ status: 'fulfilled', value: { status: 'deferred' } }];
  retry.record(candidate(TOKEN_A), deferred, options);
  assert.equal(retry.isDue(candidate(TOKEN_A)), false);
  clock = 10_000;
  assert.equal(retry.isDue(candidate(TOKEN_A)), true);
  retry.record(candidate(TOKEN_B), deferred, options);
  retry.record(candidate(`0x${'3'.repeat(40)}`), deferred, options);
  assert.equal(retry.getSize(), 2);
  assert.equal(retry.isDue(candidate(TOKEN_A)), true);
  retry.record(candidate(TOKEN_B), [{ status: 'fulfilled', value: { status: 'published' } }], options);
  assert.equal(retry.getSize(), 1);
  assert.throws(() => createHolderIntelligenceRetry({ maxEntries: 10_001 }), /capacity/);
});
