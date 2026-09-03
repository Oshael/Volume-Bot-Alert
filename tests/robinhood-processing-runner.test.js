const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodProcessingRunner, backoffFor, __private,
} = require('../src/services/robinhood-processing-runner');
const {
  createRobinhoodProcessingShadowAuditor,
} = require('../src/services/robinhood-processing-shadow-auditor');
const { ROBINHOOD_WETH } = require('../src/services/evm-market-metrics');
const v2 = require('../src/services/uniswap-v2-decoder');
const v3 = require('../src/services/uniswap-v3-decoder');
const v4 = require('../src/services/uniswap-v4-decoder');

// TOKEN sorts below WETH, matching the frozen quoteIndex=1 evidence fixture.
const TOKEN = `0x${'01'.repeat(20)}`;
const POOL = `0x${'22'.repeat(20)}`;
const POOL_ID = `0x${'33'.repeat(32)}`;
const ONE = 10n ** 18n;

function word(value) {
  const big = BigInt(value);
  const masked = big < 0n ? (1n << 256n) + big : big;
  return masked.toString(16).padStart(64, '0');
}
const addressWord = (address) => `0x${word(BigInt(address))}`;
const data = (values) => `0x${values.map(word).join('')}`;

function evidence(overrides = {}) {
  return {
    evidenceVersion: 1,
    timestampMs: '1750000000000',
    tokenAddress: TOKEN,
    quoteAddress: ROBINHOOD_WETH,
    quoteIndex: 1,
    eligibility: { eligible: true, reason: null },
    tokenMetadata: {
      name: 'T', symbol: 'T', decimals: 18, totalSupplyRaw: (1000n * ONE).toString(),
      tokenSupplyStatus: 'latest_call', tokenSupplyBlockTag: '0x64',
    },
    quoteMetadata: { decimals: 18 },
    quoteUsd: { priceUsd: '2000', source: 'canonical-weth-usdg-3000', status: 'observed', blockTag: '0x10' },
    ...overrides,
  };
}

function row(protocol, extra = {}, evidenceOverrides = {}) {
  return {
    stream: 'market', evidence_version: 1, attempt_count: 0,
    protocol, transaction_hash: `0x${'a'.repeat(63)}${extra.n || '1'}`, log_index: '0',
    block_number: '100', block_hash: `0x${'b'.repeat(64)}`, transaction_index: '0',
    market_key: `robinhood:${protocol}:${POOL}`,
    ...extra,
    evidence: evidence(evidenceOverrides),
  };
}

function v3Row(extra) {
  return row('uniswap-v3', {
    address: POOL, topics: [v3.TOPICS.swap, addressWord(TOKEN), addressWord(POOL)],
    data: data([-10n * ONE, ONE, 1n << 96n, 5n * ONE, 0n]), ...extra,
  }, { v3: { poolAddress: POOL, blockTag: '0x64', tokenBalanceRaw: (10n * ONE).toString(), quoteBalanceRaw: (30000n * ONE).toString(), sqrtPriceX96: (1n << 96n).toString() } });
}

function v2Row(extra) {
  return row('uniswap-v2', {
    address: POOL, market_key: `robinhood:uniswap-v2:${POOL}`,
    topics: [v2.TOPICS.swap, addressWord(TOKEN), addressWord(POOL)],
    data: data([0n, ONE, 10n * ONE, 0n]), ...extra,
  }, { v2: { quoteReserveRaw: (3n * ONE).toString() } });
}

function v4Row(extra) {
  return row('uniswap-v4', {
    address: v4.ROBINHOOD_V4_POOL_MANAGER, market_key: `robinhood:uniswap-v4:${POOL_ID}`,
    topics: [v4.TOPICS.swap, POOL_ID, addressWord(POOL)],
    data: data([-10n * ONE, ONE, 1n << 96n, 5n * ONE, 0n, 0n]), ...extra,
  }, { v4: { poolId: POOL_ID, sqrtPriceX96: (1n << 96n).toString(), liquidityRaw: (5n * ONE).toString(), modifyLiquidity: [] } });
}

function fakeRepo(rows) {
  const batches = Array.isArray(rows[0]) ? rows : [rows];
  const calls = { reclaimed: 0, settle: null, settlements: [], claims: 0, frontier: 0 };
  return {
    _calls: calls,
    reclaimExpiredLeases: async () => { calls.reclaimed += 1; return 0; },
    claimCaptures: async () => { calls.claims += 1; return batches[calls.claims - 1] || []; },
    getOldestActiveCapture: async () => {
      calls.frontier += 1;
      return { blockNumber: '100', observedAt: '2026-07-13T00:00:00.000Z' };
    },
    settleClaims: async (args) => {
      calls.settle = args;
      calls.settlements.push(args);
      return { processed: args.processed.length, rejected: args.rejected.length, retried: args.retry.length, blocked: 0 };
    },
  };
}

function fakePersistence({
  ranges = null,
  reference = null,
  failCommit = false,
  failTransactionHash = null,
  failMessage = 'V4 liquidity range update conflicted or became negative',
} = {}) {
  const calls = {
    attempts: [], commit: [], rangesFor: [], rangeBatches: [],
    referencesFor: [], referenceBatches: [], frontierFor: [],
  };
  return {
    _calls: calls,
    commitHeadProcessingBatch: async (input) => input.persistenceTiming.attempt(async () => {
      calls.attempts.push(input);
      if (failCommit) throw new Error('v4 materialization constraint');
      if (input.entries.some((entry) => entry.log.transactionHash === failTransactionHash)) {
        throw new Error(failMessage);
      }
      calls.commit.push(input);
      return { insertedLogs: input.entries.length, insertedObservations: 0, touchedBuckets: 0, insertedLiquidityDeltas: 0 };
    }),
    resolveMarketFrontier: async (pendingBlock) => {
      calls.frontierFor.push(pendingBlock);
      return { nextBlock: pendingBlock, checkpointTimestamp: new Date('2026-07-13T00:00:00.000Z') };
    },
    loadTokenFdvReference: async (address) => {
      calls.referencesFor.push(address);
      return reference;
    },
    loadTokenFdvReferences: async (addresses) => {
      calls.referenceBatches.push(addresses);
      return new Map(addresses.map((address) => [address, reference]));
    },
    listCurrentV4LiquidityRanges: async (poolId) => { calls.rangesFor.push(poolId); return ranges; },
    listCurrentV4LiquidityRangesByPoolIds: async (poolIds) => {
      calls.rangeBatches.push(poolIds);
      return new Map(poolIds.map((poolId) => [poolId, ranges]));
    },
  };
}

function runner(rows, persistence, options = {}, deps = {}) {
  return createRobinhoodProcessingRunner({
    repository: fakeRepo(rows), persistence, logger: { error: () => {} },
    ...deps,
    options: { owner: 'test-worker', ...options },
  });
}

describe('robinhood processing runner', () => {
  it('claims 8000 captures but persists ordered transactions of at most 2000', async () => {
    const rows = Array.from({ length: 8000 }, (_, index) => v3Row({
      transaction_hash: `0x${BigInt(index + 1).toString(16).padStart(64, '0')}`,
      log_index: String(index),
    }));
    const repository = fakeRepo(rows);
    repository.claimCaptures = async ({ limit }) => {
      assert.equal(limit, 8000);
      return rows;
    };
    const persistence = fakePersistence();
    const result = await runner(rows, persistence, { batchSize: 8000 }, { repository }).runOnce();
    assert.deepEqual(persistence._calls.commit.map(({ entries }) => entries.length), [2000, 2000, 2000, 2000]);
    assert.deepEqual(persistence._calls.commit.flatMap(({ entries }) => entries.map((entry) => (
      entry.log.transactionHash
    ))), rows.map((item) => item.transaction_hash));
    assert.deepEqual([result.claimed, result.processed, result.retried], [8000, 8000, 0]);
    assert.equal(repository._calls.settle.processed.length, 8000);
    assert.deepEqual([
      result.timing.persistence.attempts, result.timing.persistence.commits,
      result.timing.persistence.failures,
    ], [4, 4, 0]);
  });

  it('retries the uncommitted suffix after a transient failure without repeating writes', async () => {
    const rows = Array.from({ length: 4001 }, (_, index) => v3Row({
      transaction_hash: `0x${BigInt(index + 1).toString(16).padStart(64, '0')}`,
      log_index: String(index),
    }));
    const persistence = fakePersistence({
      failTransactionHash: rows[2000].transaction_hash, failMessage: 'connection lost',
    });
    const repository = fakeRepo(rows);
    const result = await runner(rows, persistence, { batchSize: 8000 }, { repository }).runOnce();
    assert.deepEqual(persistence._calls.attempts.map(({ entries }) => entries.length), [2000, 2000]);
    assert.deepEqual([result.processed, result.retried], [2000, 2001]);
    assert.deepEqual([
      result.timing.persistence.attempts, result.timing.persistence.commits,
      result.timing.persistence.failures,
    ], [2, 1, 1]);
    assert.deepEqual(repository._calls.settle.retry.map((item) => item.transactionHash),
      rows.slice(2000).map((item) => item.transaction_hash));
  });

  it('reprocesses V2/V3 captures into observations from evidence with no RPC and no ledger read', async () => {
    const persistence = fakePersistence();
    const result = await runner([v2Row({ n: '1' }), v3Row({ n: '2' })], persistence).runOnce();

    assert.equal(persistence._calls.commit.length, 1);
    const observations = persistence._calls.commit[0].entries.map((entry) => entry.observation);
    assert.deepEqual(observations.map((obs) => obs.priceUsd), ['200', '2000']);
    assert.equal(persistence._calls.attempts.length, 1);
    assert.deepEqual(persistence._calls.rangesFor, []); // V2/V3 never touch the ledger, let alone RPC
    assert.deepEqual([result.processed, result.rejected, result.retried], [2, 0, 0]);
  });

  it('values a V4 capture from the materialized tick ledger', async () => {
    const persistence = fakePersistence({ ranges: [{ tick_lower: -60, tick_upper: 60, liquidity_gross: ONE.toString() }] });
    const result = await runner([v4Row()], persistence).runOnce();

    assert.deepEqual(persistence._calls.rangeBatches, [[POOL_ID]]);
    assert.deepEqual(persistence._calls.rangesFor, []);
    const [entry] = persistence._calls.commit[0].entries;
    assert.equal(entry.observation.liquidityStatus, 'spot_tvl_from_v4_tick_ranges');
    assert.equal(result.processed, 1);
  });

  it('reads FDV references and V4 ranges in one batch query per resource', async () => {
    const persistence = fakePersistence({
      ranges: [{ tick_lower: -60, tick_upper: 60, liquidity_gross: ONE.toString() }],
    });

    const result = await runner([
      v4Row({ n: '1', log_index: '1' }),
      v4Row({ n: '2', log_index: '2' }),
    ], persistence).runOnce();

    assert.deepEqual(persistence._calls.rangeBatches, [[POOL_ID]]);
    assert.deepEqual(persistence._calls.referenceBatches, [[TOKEN]]);
    assert.deepEqual(persistence._calls.rangesFor, []);
    assert.deepEqual(persistence._calls.referencesFor, []);
    assert.equal(result.processed, 2);
  });

  it('drains a hot V4 pool in sequential rounds with a fresh ledger read per commit', async () => {
    const first = v4Row({ n: '1', block_number: '100', log_index: '1' });
    const second = v4Row({ n: '2', block_number: '101', log_index: '2' });
    const repository = fakeRepo([first]);
    let continuationCalls = 0;
    repository.claimV4Continuations = async ({ marketKeys }) => {
      assert.deepEqual(marketKeys, [first.market_key]);
      continuationCalls += 1;
      return continuationCalls === 1 ? [second] : [];
    };
    const persistence = fakePersistence({
      ranges: [{ tick_lower: -60, tick_upper: 60, liquidity_gross: ONE.toString() }],
    });
    const theRunner = createRobinhoodProcessingRunner({
      repository, persistence, logger: { error: () => {} },
      options: { owner: 'test-worker', v4ContinuationRounds: 2 },
    });

    const result = await theRunner.runOnce();

    assert.deepEqual(persistence._calls.commit.map(({ entries }) => (
      entries.map((entry) => entry.log.transactionHash)
    )), [[first.transaction_hash], [second.transaction_hash]]);
    assert.deepEqual(persistence._calls.rangeBatches, [[POOL_ID], [POOL_ID]]);
    assert.equal(repository._calls.settlements.length, 2);
    assert.deepEqual(
      [result.claimed, result.processed, result.continuationRounds, result.continuationClaimed],
      [2, 2, 1, 1]
    );
    assert.equal(result.continuationPools, 1);
    assert.equal(result.timing.persistence.attempts, 2);
    assert.equal(result.timing.persistence.commits, 2);
    const idle = await theRunner.runOnce();
    assert.equal(idle.timing.persistence.attempts, 0);
    assert.equal(result.timing.persistence.attempts, 2);
  });

  it('continues only the oldest bounded V4 pool frontiers for the whole tick', async () => {
    const first = v4Row({ n: '1', block_number: '100', log_index: '1' });
    const secondPool = `0x${'44'.repeat(32)}`;
    const second = v4Row({
      n: '2', block_number: '101', log_index: '2',
      market_key: `robinhood:uniswap-v4:${secondPool}`,
    });
    second.topics[1] = secondPool;
    second.evidence.v4.poolId = secondPool;
    const thirdPool = `0x${'55'.repeat(32)}`;
    const third = v4Row({
      n: '3', block_number: '102', log_index: '3',
      market_key: `robinhood:uniswap-v4:${thirdPool}`,
    });
    third.topics[1] = thirdPool;
    third.evidence.v4.poolId = thirdPool;
    const repository = fakeRepo([first, second, third]);
    let continuationCalls = 0;
    repository.claimV4Continuations = async ({ marketKeys, limit, perPoolLimit }) => {
      continuationCalls += 1;
      assert.deepEqual(marketKeys, [first.market_key, second.market_key]);
      assert.equal(limit, 200);
      assert.equal(perPoolLimit, 512);
      return continuationCalls === 1 ? [first, second] : [];
    };
    const theRunner = createRobinhoodProcessingRunner({
      repository,
      persistence: fakePersistence({ ranges: [] }),
      logger: { error: () => {} },
      options: {
        owner: 'test-worker', v4ContinuationRounds: 2, v4ContinuationPoolLimit: 2,
      },
    });

    const result = await theRunner.runOnce();

    assert.equal(continuationCalls, 2);
    assert.deepEqual(
      [result.continuationPools, result.continuationRounds, result.continuationClaimed],
      [2, 1, 2]
    );
  });

  it('reuses FDV references until TTL expiry while guarding every observation', async () => {
    let now = 1000;
    const persistence = fakePersistence({ reference: '100000' });
    const repository = fakeRepo([
      [v3Row({ n: '1' })], [v3Row({ n: '2' })], [v3Row({ n: '3' })],
    ]);
    const theRunner = createRobinhoodProcessingRunner({
      repository, persistence, logger: { error: () => {} }, now: () => now,
      options: {
        owner: 'test-worker',
        deadPoolGuard: {
          sampleSize: 50, cacheTtlMs: 60_000, cacheMaxEntries: 100,
          maxMultiple: 2, minVolumeUsd: 1_000_000,
        },
      },
    });

    const first = await theRunner.runOnce();
    now += 59_000;
    const cached = await theRunner.runOnce();
    now += 2_000;
    const refreshed = await theRunner.runOnce();

    assert.deepEqual(persistence._calls.referenceBatches, [[TOKEN], [TOKEN]]);
    assert.deepEqual(
      [first.timing.fdvCacheMisses, cached.timing.fdvCacheHits,
        refreshed.timing.fdvCacheMisses],
      [1, 1, 1]
    );
    assert.equal(persistence._calls.commit.length, 3);
    assert.equal(persistence._calls.commit.every(({ entries }) => (
      entries[0].observation.accepted === false
        && entries[0].observation.reason === 'dead_pool_price'
    )), true);
  });

  it('bounds the FDV cache and evicts the least recently used token', () => {
    const cache = __private.createFdvReferenceCache({
      ttlMs: 60_000, maxEntries: 2, now: () => 1000,
    });
    cache.set('token-a', '1');
    cache.set('token-b', '2');
    cache.get('token-a');
    cache.set('token-c', '3');

    assert.equal(cache.size, 2);
    assert.equal(cache.get('token-a').hit, true);
    assert.equal(cache.get('token-b').hit, false);
    assert.equal(cache.get('token-c').hit, true);
  });

  it('retries the batch with backoff and never marks it processed when persistence fails', async () => {
    const persistence = fakePersistence({ failCommit: true });
    const repository = fakeRepo([v3Row({ attempt_count: 2 })]);
    const theRunner = createRobinhoodProcessingRunner({
      repository, persistence, logger: { error: () => {} },
      options: { owner: 'test-worker', baseBackoffMs: 1000, maxBackoffMs: 300000 },
    });
    const result = await theRunner.runOnce();

    assert.equal(result.processed, 0);
    assert.equal(result.retried, 1);
    assert.equal(persistence._calls.commit.length, 0);
    assert.equal(persistence._calls.attempts.length, 1);
    assert.equal(repository._calls.settle.retry[0].backoffMs, 2000); // 1000 * 2^(2-1)
  });

  it('isolates a deterministic V4 range failure without retrying healthy claims', async () => {
    const healthyBefore = v2Row({ n: '1' });
    const poison = v4Row({ n: '2' });
    const healthyAfter = v3Row({ n: '3' });
    const persistence = fakePersistence({ failTransactionHash: poison.transaction_hash });
    const repository = fakeRepo([healthyBefore, poison, healthyAfter]);
    const theRunner = createRobinhoodProcessingRunner({
      repository,
      persistence,
      logger: { error: () => {} },
      options: { owner: 'test-worker' },
    });

    const result = await theRunner.runOnce();

    assert.deepEqual(
      [result.processed, result.retried, result.blocked],
      [2, 1, 0]
    );
    assert.deepEqual(
      repository._calls.settle.processed.map((entry) => entry.transactionHash),
      [healthyBefore.transaction_hash, healthyAfter.transaction_hash]
    );
    assert.deepEqual(repository._calls.settle.retry.map((entry) => entry.transactionHash), [
      poison.transaction_hash,
    ]);
    assert.deepEqual(
      persistence._calls.commit.flatMap((input) => (
        input.entries.map((entry) => entry.log.transactionHash)
      )),
      [healthyBefore.transaction_hash, healthyAfter.transaction_hash]
    );
  });

  it('never commits a V4 suffix after its predecessor fails during isolation', async () => {
    const first = v4Row({ n: '1', log_index: '1' });
    const poison = v4Row({ n: '2', log_index: '2' });
    const suffix = v4Row({ n: '3', log_index: '3' });
    const independent = v3Row({ n: '4', log_index: '4' });
    const persistence = fakePersistence({ failTransactionHash: poison.transaction_hash });
    const repository = fakeRepo([first, poison, suffix, independent]);
    const theRunner = createRobinhoodProcessingRunner({
      repository, persistence, logger: { error: () => {} },
      options: { owner: 'test-worker' },
    });

    const result = await theRunner.runOnce();

    assert.deepEqual([result.processed, result.retried], [2, 2]);
    assert.deepEqual(persistence._calls.commit.flatMap(({ entries }) => (
      entries.map((entry) => entry.log.transactionHash)
    )), [first.transaction_hash, independent.transaction_hash]);
    assert.deepEqual(repository._calls.settle.retry.map((entry) => entry.transactionHash), [
      poison.transaction_hash, suffix.transaction_hash,
    ]);
  });

  it('settles head rejections and unknown evidence as terminals without persisting', async () => {
    const persistence = fakePersistence();
    const rejected = v3Row({ n: '3' });
    rejected.evidence = { evidenceVersion: 1, rejected: 'v3_pool_balance_unavailable', tokenAddress: TOKEN };
    const unknown = v3Row({ n: '4', evidence_version: 999 });

    const result = await runner([rejected, unknown], persistence).runOnce();

    assert.equal(persistence._calls.commit.length, 0);
    assert.equal(result.rejected, 2);
    assert.equal(result.processed, 0);
  });

  it('reclaims abandoned leases and short-circuits when nothing is pending', async () => {
    const persistence = fakePersistence();
    const result = await runner([], persistence).runOnce();

    assert.equal(result.reclaimed, 0);
    assert.equal(result.claimed, 0);
    assert.equal(persistence._calls.commit.length, 0);
  });

  it('resolves and passes the derived-emit frontier to the commit when outbox emission is on', async () => {
    const persistence = fakePersistence();
    await runner([v3Row()], persistence, { emitOutbox: true }).runOnce();

    assert.deepEqual(persistence._calls.frontierFor, ['100']); // the queue's pending block
    const { emit } = persistence._calls.commit[0];
    assert.equal(emit.nextBlock, '100');
    assert.equal(emit.checkpointTimestamp.toISOString(), '2026-07-13T00:00:00.000Z');
  });

  it('never resolves or passes a frontier when outbox emission is off (default)', async () => {
    const persistence = fakePersistence();
    await runner([v3Row()], persistence).runOnce();

    assert.deepEqual(persistence._calls.frontierFor, []);
    assert.equal(persistence._calls.commit[0].emit ?? null, null);
  });

  it('reports shadow comparison without changing processing settlement', async () => {
    const persistence = fakePersistence();
    const calls = [];
    const shadowAuditor = {
      compare: async (entries) => {
        calls.push(entries);
        return { attempted: 1, compared: 1, matched: 1, mismatched: 0, missing: 0, samples: [] };
      },
    };

    const result = await runner([v3Row()], persistence, {}, { shadowAuditor }).runOnce();

    assert.equal(calls[0].length, 1);
    assert.equal(result.shadowAudit.matched, 1);
    assert.equal(result.processed, 1);
  });

  it('feeds the auditor the persistence-normalizable decoded observation contract', async () => {
    const persistence = fakePersistence();
    const shadowAuditor = createRobinhoodProcessingShadowAuditor({
      database: { query: async () => ({ rows: [] }) },
      logger: { warn() {} },
    });

    const result = await runner([v3Row()], persistence, {}, { shadowAuditor }).runOnce();

    assert.equal(result.shadowAudit.attempted, 1);
    assert.equal(result.shadowAudit.missing, 1);
    assert.equal(result.shadowAudit.errors, 0);
    assert.equal(result.processed, 1);
  });

  it('fails shadow audit open and still commits and settles the batch', async () => {
    const persistence = fakePersistence();
    const shadowAuditor = { compare: async () => { throw new Error('audit unavailable'); } };

    const result = await runner([v3Row()], persistence, {}, { shadowAuditor }).runOnce();

    assert.equal(result.shadowAudit.errors, 1);
    assert.equal(result.shadowAudit.lastError, 'audit unavailable');
    assert.equal(persistence._calls.commit.length, 1);
    assert.equal(result.processed, 1);
  });

  it('grows the retry backoff exponentially with a ceiling', () => {
    assert.equal(backoffFor(1, 1000, 300000), 1000);
    assert.equal(backoffFor(3, 1000, 300000), 4000);
    assert.equal(backoffFor(50, 1000, 300000), 300000);
  });
});
