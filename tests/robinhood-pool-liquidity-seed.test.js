const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodPoolLiquiditySeedRepository,
} = require('../src/models/robinhood-pool-liquidity-seed');
const {
  runRobinhoodPoolLiquiditySeed,
} = require('../src/services/robinhood-pool-liquidity-seed');
const {
  createProgressReporter,
} = require('../src/utils/seed-robinhood-pool-liquidity');

const HASH = `0x${'a'.repeat(64)}`;

function candidate(marketKey, blockNumber = '100') {
  return {
    protocol: 'uniswap-v3', marketKey, blockNumber,
    liquidityUsd: '42', liquidityRaw: '9',
    liquidityStatus: 'spot_tvl_from_pool_balances',
    liquidityConfidence: 'medium', liquidityWarning: null,
  };
}

describe('Robinhood pool liquidity historical seed', () => {
  it('uses per-pool indexed lookups instead of global history scans', async () => {
    const calls = [];
    const progress = [];
    const repository = createRobinhoodPoolLiquiditySeedRepository({ database: {
      async query(sql, params) {
        calls.push({ sql, params });
        if (/COUNT\(\*\)/.test(sql)) return { rows: [{ total: '2' }] };
        const marketKey = params[2] == null ? 'pool-a' : 'pool-b';
        return { rows: [{
          protocol: 'uniswap-v3', market_key: marketKey, block_number: '100',
          liquidity_usd: '42', liquidity_raw: '9',
          liquidity_status: 'spot_tvl_from_pool_balances',
          liquidity_confidence: 'medium', liquidity_warning: null,
          snapshot_block_number: marketKey === 'pool-b' ? '100' : null,
        }] };
      },
    } });
    const rows = await repository.listCandidates({
      throughBlock: '110', batchSize: 1, onProgress: (state) => progress.push(state),
    });
    assert.deepEqual(rows.map(({ marketKey }) => marketKey), ['pool-a']);
    assert.deepEqual(calls[1].params, ['110', null, null, 1]);
    assert.deepEqual(calls[2].params, ['110', 'uniswap-v3', 'pool-a', 1]);
    assert.match(calls[1].sql, /robinhood_market_buckets_1m/);
    assert.match(calls[1].sql, /robinhood_market_buckets_1h/);
    assert.match(calls[1].sql, /FROM token_catalog catalog/);
    assert.match(calls[1].sql, /LEFT JOIN LATERAL/);
    assert.match(calls[1].sql, /minute\.market_key = pool\.market_key/);
    assert.match(calls[1].sql, /hour\.market_key = pool\.market_key/);
    assert.doesNotMatch(calls[1].sql, /SELECT DISTINCT ON/);
    assert.doesNotMatch(calls[1].sql, /robinhood_market_observations/);
    assert.deepEqual(progress, [
      { processed: 0, total: 2, candidates: 0 },
      { processed: 1, total: 2, candidates: 1 },
      { processed: 2, total: 2, candidates: 1 },
    ]);
  });

  it('writes snapshots and the event cursor in one transaction', async () => {
    const calls = [];
    const client = {
      async query(sql, params) {
        calls.push({ sql, params });
        if (/INSERT INTO robinhood_pool_liquidity_event_cursors/.test(sql)) {
          return { rowCount: 1, rows: [{ next_block: '111' }] };
        }
        return { rowCount: /INSERT INTO robinhood_pool_liquidity_snapshots/.test(sql) ? 1 : 0 };
      },
      release() { calls.push({ sql: 'RELEASE' }); },
    };
    const repository = createRobinhoodPoolLiquiditySeedRepository({ database: {
      async getClient() { return client; },
    } });
    const result = await repository.commitSeed({
      rows: [{ protocol: 'uniswap-v3', market_key: 'pool' }], startBlock: '111',
    });
    assert.deepEqual(result, { written: 1, startBlock: '111' });
    assert.equal(calls[0].sql, 'BEGIN');
    assert.deepEqual(calls.find(({ sql }) => /event_cursors/.test(sql)).params, [
      'robinhood', '111',
    ]);
    assert.equal(calls.at(-2).sql, 'COMMIT');
    assert.equal(calls.at(-1).sql, 'RELEASE');
  });

  it('previews without RPC and writes each distinct canonical block once', async () => {
    const candidates = [candidate('pool-a'), candidate('pool-b'), candidate('pool-c', '101')];
    const committed = [];
    const dependencies = {
      cursorRepository: {
        async loadCursor() { return null; },
        async resolveProcessingFrontier() { return '110'; },
      },
      repository: {
        async listCandidates(input = {}) {
          input.onProgress?.({ processed: 3, total: 3, candidates: 3 });
          return candidates;
        },
        async commitSeed(input) {
          committed.push(input);
          input.onProgress?.({ processed: input.rows.length, total: input.rows.length, written: 3 });
          return { written: input.rows.length, startBlock: input.startBlock };
        },
      },
    };
    assert.deepEqual(await runRobinhoodPoolLiquiditySeed(dependencies), {
      mode: 'dry-run', throughBlock: '110', startBlock: '111',
      candidates: 3, distinctBlocks: 2, written: 0,
    });
    const requested = [];
    dependencies.rpcClient = { async request(method, params) {
      requested.push(params[0]);
      const number = BigInt(params[0]);
      return { number: params[0], hash: HASH, timestamp: `0x${(1000n + number).toString(16)}` };
    } };
    const progress = [];
    const result = await runRobinhoodPoolLiquiditySeed(dependencies, {
      write: true, onProgress: (state) => progress.push(state),
    });
    assert.deepEqual(requested.sort(), ['0x64', '0x65']);
    assert.equal(committed[0].rows.length, 3);
    assert.equal(committed[0].startBlock, '111');
    assert.equal(result.cursorInitialized, true);
    assert.equal(result.written, 3);
    assert.deepEqual(new Set(progress.map(({ phase }) => phase)),
      new Set(['count', 'scan', 'headers', 'commit']));
  });

  it('prints phase progress with elapsed time and ETA', () => {
    const messages = [];
    const report = createProgressReporter({ error(message) { messages.push(message); } }, () => 2000);
    report({
      phase: 'scan', processed: 25, total: 100, candidates: 4,
      elapsedMs: 10_000, etaMs: 30_000,
    });
    assert.match(messages[0], /scan 25\/100 \(25\.0%\) candidates=4/);
    assert.match(messages[0], /elapsed=10s eta=30s/);
  });

  it('prints the counting preflight before an ETA is available', () => {
    const messages = [];
    const report = createProgressReporter({ error(message) { messages.push(message); } });
    report({ phase: 'count', processed: 0, total: 0, elapsedMs: 0, etaMs: null });
    assert.deepEqual(messages, ['[LiquiditySeed] preflight counting relevant pools...']);
  });

  it('refuses a write after the event cursor exists', async () => {
    await assert.rejects(runRobinhoodPoolLiquiditySeed({
      cursorRepository: { async loadCursor() { return { nextBlock: '111' }; } },
      repository: {},
    }, { write: true }), (error) => error.code === 'liquidity_seed_after_cursor');
  });
});
