const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodPoolLiquiditySeedRepository,
} = require('../src/models/robinhood-pool-liquidity-seed');
const {
  runRobinhoodPoolLiquiditySeed,
} = require('../src/services/robinhood-pool-liquidity-seed');

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
  it('collapses indexed buckets before selecting the latest valid evidence', async () => {
    const calls = [];
    const repository = createRobinhoodPoolLiquiditySeedRepository({ database: {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [{
          protocol: 'uniswap-v3', market_key: 'pool', block_number: '100',
          liquidity_usd: '42', liquidity_raw: '9',
          liquidity_status: 'spot_tvl_from_pool_balances',
          liquidity_confidence: 'medium', liquidity_warning: null,
        }] };
      },
    } });
    const rows = await repository.listCandidates({ throughBlock: '110' });
    assert.equal(rows[0].marketKey, 'pool');
    assert.deepEqual(calls[0].params, ['110']);
    assert.match(calls[0].sql, /robinhood_market_buckets_1m/);
    assert.match(calls[0].sql, /robinhood_market_buckets_1h/);
    assert.match(calls[0].sql,
      /latest_1m AS \(\s*SELECT DISTINCT ON \(protocol, market_key\)/);
    assert.match(calls[0].sql,
      /latest_1h AS \(\s*SELECT DISTINCT ON \(protocol, market_key\)/);
    assert.doesNotMatch(calls[0].sql, /robinhood_market_observations/);
    assert.match(calls[0].sql, /latest\.block_number > snapshot\.snapshot_block_number/);
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
        async listCandidates() { return candidates; },
        async commitSeed(input) {
          committed.push(input);
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
    const result = await runRobinhoodPoolLiquiditySeed(dependencies, { write: true });
    assert.deepEqual(requested.sort(), ['0x64', '0x65']);
    assert.equal(committed[0].rows.length, 3);
    assert.equal(committed[0].startBlock, '111');
    assert.equal(result.cursorInitialized, true);
    assert.equal(result.written, 3);
  });

  it('refuses a write after the event cursor exists', async () => {
    await assert.rejects(runRobinhoodPoolLiquiditySeed({
      cursorRepository: { async loadCursor() { return { nextBlock: '111' }; } },
      repository: {},
    }, { write: true }), (error) => error.code === 'liquidity_seed_after_cursor');
  });
});
