const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createRobinhoodProcessingRunner, backoffFor } = require('../src/services/robinhood-processing-runner');
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
  const calls = { reclaimed: 0, settle: null, claims: 0, watermark: 0 };
  return {
    _calls: calls,
    reclaimExpiredLeases: async () => { calls.reclaimed += 1; return 0; },
    claimCaptures: async () => { calls.claims += 1; return calls.claims === 1 ? rows : []; },
    getProcessingWatermark: async () => { calls.watermark += 1; return { pendingBlock: '100' }; },
    settleClaims: async (args) => {
      calls.settle = args;
      return { processed: args.processed.length, rejected: args.rejected.length, retried: args.retry.length, blocked: 0 };
    },
  };
}

function fakePersistence({ ranges = null, failCommit = false } = {}) {
  const calls = { commit: [], rangesFor: [], frontierFor: [] };
  return {
    _calls: calls,
    commitHeadProcessingBatch: async (input) => {
      if (failCommit) throw new Error('v4 materialization constraint');
      calls.commit.push(input);
      return { insertedLogs: input.entries.length, insertedObservations: 0, touchedBuckets: 0, insertedLiquidityDeltas: 0 };
    },
    resolveMarketFrontier: async (pendingBlock) => {
      calls.frontierFor.push(pendingBlock);
      return { nextBlock: pendingBlock, checkpointTimestamp: new Date('2026-07-13T00:00:00.000Z') };
    },
    listCurrentV4LiquidityRanges: async (poolId) => { calls.rangesFor.push(poolId); return ranges; },
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
  it('reprocesses V2/V3 captures into observations from evidence with no RPC and no ledger read', async () => {
    const persistence = fakePersistence();
    const result = await runner([v2Row({ n: '1' }), v3Row({ n: '2' })], persistence).runOnce();

    assert.equal(persistence._calls.commit.length, 1);
    const observations = persistence._calls.commit[0].entries.map((entry) => entry.observation);
    assert.deepEqual(observations.map((obs) => obs.priceUsd), ['200', '2000']);
    assert.deepEqual(persistence._calls.rangesFor, []); // V2/V3 never touch the ledger, let alone RPC
    assert.deepEqual([result.processed, result.rejected, result.retried], [2, 0, 0]);
  });

  it('values a V4 capture from the materialized tick ledger', async () => {
    const persistence = fakePersistence({ ranges: [{ tick_lower: -60, tick_upper: 60, liquidity_gross: ONE.toString() }] });
    const result = await runner([v4Row()], persistence).runOnce();

    assert.deepEqual(persistence._calls.rangesFor, [POOL_ID]);
    const [entry] = persistence._calls.commit[0].entries;
    assert.equal(entry.observation.liquidityStatus, 'spot_tvl_from_v4_tick_ranges');
    assert.equal(result.processed, 1);
  });

  it('reads V4 materialized ranges once per pool within a processing batch', async () => {
    const persistence = fakePersistence({
      ranges: [{ tick_lower: -60, tick_upper: 60, liquidity_gross: ONE.toString() }],
    });

    const result = await runner([
      v4Row({ n: '1', log_index: '1' }),
      v4Row({ n: '2', log_index: '2' }),
    ], persistence).runOnce();

    assert.deepEqual(persistence._calls.rangesFor, [POOL_ID]);
    assert.equal(result.processed, 2);
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
    assert.equal(repository._calls.settle.retry[0].backoffMs, 2000); // 1000 * 2^(2-1)
  });

  it('settles head rejections and unknown evidence as terminals without persisting', async () => {
    const persistence = fakePersistence();
    const rejected = v3Row({ n: '3' });
    rejected.evidence = { evidenceVersion: 1, rejected: 'v3_pool_balance_unavailable', tokenAddress: TOKEN };
    const unknown = v3Row({ n: '4', evidence_version: 2 });

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
