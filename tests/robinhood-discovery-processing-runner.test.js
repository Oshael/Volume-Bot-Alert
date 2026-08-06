const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodDiscoveryProcessingRunner,
  backoffFor,
} = require('../src/services/robinhood-discovery-processing-runner');

const HASH = (n) => `0x${String(n).repeat(64).slice(0, 64)}`;

function discoveryRow(n, extra = {}) {
  return {
    stream: 'discovery', evidence_version: 1, attempt_count: 0,
    transaction_hash: HASH(n), log_index: '0', block_number: '100',
    ...extra,
  };
}

// Routes each row by its transaction_hash to a decode result (or throws it).
function fakeDecoder(byHash) {
  return {
    decodeCapture(row) {
      const result = byHash[row.transaction_hash];
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function fakeRepo(rows) {
  const calls = { reclaimed: 0, claims: 0, lastClaim: null, settle: null };
  return {
    _calls: calls,
    reclaimExpiredLeases: async () => { calls.reclaimed += 1; return 3; },
    claimCaptures: async (input) => {
      calls.claims += 1;
      calls.lastClaim = input;
      return calls.claims === 1 ? rows : [];
    },
    settleClaims: async (args) => {
      calls.settle = args;
      return {
        processed: args.processed.length,
        rejected: args.rejected.length,
        retried: args.retry.length,
        blocked: 0,
      };
    },
  };
}

function fakePersistence({ failCommit = false } = {}) {
  const calls = { commit: [] };
  return {
    _calls: calls,
    commitDiscoveryProcessingBatch: async (input) => {
      if (failCommit) throw new Error('pool write failed');
      calls.commit.push(input);
      return { insertedLogs: input.entries.length, duplicateLogs: 0, upsertedPools: input.entries.length, updatedNoxaLaunches: 0 };
    },
  };
}

function terminal(message) {
  const error = new Error(message);
  error.terminal = true;
  return error;
}

function runner(rows, decoder, persistence, options = {}) {
  return createRobinhoodDiscoveryProcessingRunner({
    repository: fakeRepo(rows), persistence, decoder, logger: { error: () => {} },
    options: { owner: 'test-worker', ...options },
  });
}

describe('robinhood discovery processing runner', () => {
  it('claims the discovery stream and registers decoded pools with no RPC', async () => {
    const rows = [discoveryRow(1), discoveryRow(2)];
    const decoder = fakeDecoder({
      [HASH(1)]: { kind: 'discovery', log: { l: 1 }, event: { e: 1 } },
      [HASH(2)]: { kind: 'discovery', log: { l: 2 }, event: { e: 2 } },
    });
    const persistence = fakePersistence();
    const repo = fakeRepo(rows);
    const theRunner = createRobinhoodDiscoveryProcessingRunner({
      repository: repo, persistence, decoder, logger: { error: () => {} },
      options: { owner: 'test-worker' },
    });

    const result = await theRunner.runOnce();

    assert.equal(repo._calls.lastClaim.stream, 'discovery');
    assert.deepEqual(persistence._calls.commit[0].entries, [
      { log: { l: 1 }, event: { e: 1 } },
      { log: { l: 2 }, event: { e: 2 } },
    ]);
    assert.deepEqual([result.processed, result.rejected, result.retried], [2, 0, 0]);
  });

  it('does not reclaim by default (the co-located market runner owns chain-wide reclaim)', async () => {
    const rows = [discoveryRow(1)];
    const decoder = fakeDecoder({ [HASH(1)]: { kind: 'discovery', log: {}, event: {} } });
    const repo = fakeRepo(rows);
    const theRunner = createRobinhoodDiscoveryProcessingRunner({
      repository: repo, persistence: fakePersistence(), decoder, logger: { error: () => {} },
      options: { owner: 'test-worker' },
    });

    const result = await theRunner.runOnce();

    assert.equal(repo._calls.reclaimed, 0);
    assert.equal(result.reclaimed, 0);
  });

  it('reclaims when it owns its own process (options.reclaim)', async () => {
    const rows = [];
    const repo = fakeRepo(rows);
    const theRunner = createRobinhoodDiscoveryProcessingRunner({
      repository: repo, persistence: fakePersistence(),
      decoder: fakeDecoder({}), logger: { error: () => {} },
      options: { owner: 'test-worker', reclaim: true },
    });

    const result = await theRunner.runOnce();

    assert.equal(repo._calls.reclaimed, 1);
    assert.equal(result.reclaimed, 3);
  });

  it('settles unsupported evidence and unexpected kinds as terminals without persisting', async () => {
    const rows = [discoveryRow(1), discoveryRow(2)];
    const decoder = fakeDecoder({
      [HASH(1)]: terminal('Unsupported head evidence version: 0'),
      [HASH(2)]: { kind: 'observation', log: {}, swap: {} },
    });
    const persistence = fakePersistence();

    const result = await runner(rows, decoder, persistence).runOnce();

    assert.equal(persistence._calls.commit.length, 0);
    assert.equal(result.rejected, 2);
    assert.equal(result.processed, 0);
  });

  it('retries the batch with backoff and never marks it processed when the commit fails', async () => {
    const rows = [discoveryRow(1, { attempt_count: 2 })];
    const decoder = fakeDecoder({ [HASH(1)]: { kind: 'discovery', log: {}, event: {} } });
    const persistence = fakePersistence({ failCommit: true });
    const repo = fakeRepo(rows);
    const theRunner = createRobinhoodDiscoveryProcessingRunner({
      repository: repo, persistence, decoder, logger: { error: () => {} },
      options: { owner: 'test-worker', baseBackoffMs: 1000, maxBackoffMs: 300000 },
    });

    const result = await theRunner.runOnce();

    assert.equal(result.processed, 0);
    assert.equal(result.retried, 1);
    assert.equal(persistence._calls.commit.length, 0);
    assert.equal(repo._calls.settle.retry[0].backoffMs, 2000); // 1000 * 2^(2-1)
  });

  it('short-circuits when nothing is pending', async () => {
    const persistence = fakePersistence();
    const result = await runner([], fakeDecoder({}), persistence).runOnce();

    assert.deepEqual([result.claimed, result.processed], [0, 0]);
    assert.equal(persistence._calls.commit.length, 0);
  });

  it('grows the retry backoff exponentially with a ceiling', () => {
    assert.equal(backoffFor(1, 1000, 300000), 1000);
    assert.equal(backoffFor(3, 1000, 300000), 4000);
    assert.equal(backoffFor(50, 1000, 300000), 300000);
  });
});
