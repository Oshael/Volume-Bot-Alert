const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage147 = require('../src/utils/db-init-stage147');
const {
  createRobinhoodPoolLiquiditySnapshotRepository,
} = require('../src/models/robinhood-pool-liquidity-snapshot');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

const TOKEN = `0x${'1'.repeat(40)}`;
const QUOTE = `0x${'2'.repeat(40)}`;
const POOL_ID = `0x${'3'.repeat(64)}`;
const MARKET = `robinhood:uniswap-v4:${POOL_ID}`;

describe('Robinhood current pool liquidity snapshots', () => {
  it('defines a pool-keyed, monotonic and auditable current-state table', () => {
    const sql = stage147.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage147-robinhood-pool-liquidity-snapshots'
    ));
    assert.match(sql, /PRIMARY KEY \(chain, protocol, market_key\)/);
    assert.match(sql, /REFERENCES robinhood_pool_registry/);
    assert.match(sql, /snapshot_block_hash ~ '\^0x\[0-9a-f\]\{64\}\$'/);
    assert.match(sql, /protocol = 'uniswap-v4' AND liquidity_raw IS NOT NULL/);
    assert.match(sql, /consecutive_failures > 0/);
    assert.equal(group.repair, 'node src/utils/db-init-stage147.js');
  });

  it('prioritizes never-checked active pools and normalizes their identity', async () => {
    const calls = [];
    const repository = createRobinhoodPoolLiquiditySnapshotRepository({ database: {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [{
          protocol: 'uniswap-v4', market_key: MARKET, pool_address: null,
          pool_id: POOL_ID, origin_address: `0x${'4'.repeat(40)}`,
          token_address: TOKEN, quote_address: QUOTE,
          currency0: TOKEN, currency1: QUOTE,
          discovered_at: new Date('2026-08-22T10:00:00Z'), consecutive_failures: '0',
        }] };
      },
    } });
    const rows = await repository.listDuePools({
      dueBefore: '2026-08-22T11:00:00Z', limit: 25,
    });
    assert.equal(rows[0].marketKey, MARKET);
    assert.equal(rows[0].poolId, POOL_ID);
    assert.match(calls[0].sql, /snapshot\.checked_at ASC NULLS FIRST/);
    assert.deepEqual(calls[0].params, ['2026-08-22T11:00:00.000Z', 25]);
  });

  it('anchors snapshots before the oldest unfinished market capture', async () => {
    const repository = createRobinhoodPoolLiquiditySnapshotRepository({ database: {
      async query(sql) {
        assert.match(sql, /processing_status IN \('pending', 'leased', 'blocked'\)/);
        return { rows: [{ checkpoint_block: '200', pending_block: '151' }] };
      },
    } });
    assert.equal(await repository.resolveAnchorBlock(), '150');
  });

  it('writes a valid snapshot without allowing inconsistent evidence', async () => {
    const calls = [];
    const repository = createRobinhoodPoolLiquiditySnapshotRepository({ database: {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rowCount: 1 };
      },
    } });
    assert.equal(await repository.recordSnapshot({
      protocol: 'uniswap-v4', marketKey: MARKET, blockNumber: '123',
      blockHash: `0x${'a'.repeat(64)}`, observedAt: '2026-08-22T11:00:00Z',
      checkedAt: '2026-08-22T11:00:01Z', liquidityUsd: '42.5', liquidityRaw: '9',
      liquidityStatus: 'spot_tvl_from_v4_tick_ranges', liquidityConfidence: 'medium',
      liquidityWarning: 'spot_price_and_tick_liquidity_are_manipulable',
    }), true);
    assert.match(calls[0].sql, /EXCLUDED\.snapshot_block_number >=/);
    assert.equal(calls[0].params[2], '123');
    await assert.rejects(repository.recordSnapshot({
      protocol: 'uniswap-v4', marketKey: MARKET, blockNumber: '124',
      blockHash: `0x${'b'.repeat(64)}`, observedAt: '2026-08-22T11:01:00Z',
      liquidityUsd: null, liquidityRaw: null,
      liquidityStatus: 'spot_tvl_from_v4_tick_ranges', liquidityConfidence: 'medium',
    }), /assessment is inconsistent/);
  });

  it('records a failure without replacing the last valid snapshot fields', async () => {
    const calls = [];
    const repository = createRobinhoodPoolLiquiditySnapshotRepository({ database: {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rowCount: 1 };
      },
    } });
    assert.equal(await repository.recordFailure({
      protocol: 'uniswap-v4', marketKey: MARKET,
      checkedAt: '2026-08-22T12:00:00Z',
      error: { code: 'RPC Error!', message: 'temporary failure' },
    }), true);
    assert.match(calls[0].sql, /consecutive_failures \+ 1/);
    assert.doesNotMatch(calls[0].sql, /liquidity_usd = EXCLUDED/);
    assert.equal(calls[0].params[3], 'rpc_error_');
  });
});
