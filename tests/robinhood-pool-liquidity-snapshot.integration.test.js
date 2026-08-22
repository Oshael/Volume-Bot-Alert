process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage63 = require('../src/utils/db-init-stage63');
const stage147 = require('../src/utils/db-init-stage147');
const {
  createRobinhoodPoolLiquiditySnapshotRepository,
} = require('../src/models/robinhood-pool-liquidity-snapshot');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const POOL = `0x${'7'.repeat(40)}`;
const TOKEN = `0x${'8'.repeat(40)}`;
const QUOTE = `0x${'9'.repeat(40)}`;
const MARKET = `robinhood:uniswap-v3:${POOL}`;

async function cleanup() {
  await db.query('DELETE FROM robinhood_pool_registry WHERE market_key = $1', [MARKET]);
}

describe('Robinhood pool liquidity snapshot persistence integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage63.init({ closePool: false });
    await stage147.init({ closePool: false });
    await stage147.init({ closePool: false });
    await cleanup();
    await db.query(
      `INSERT INTO robinhood_pool_registry (
         protocol, market_key, pool_address, origin_address, token_address,
         quote_address, currency0, currency1, discovery_block,
         discovery_block_hash, discovery_tx_hash, discovery_log_index, discovered_at
       ) VALUES ('uniswap-v3', $1, $2, $2, $3, $4, $3, $4, 10,
         $5, $6, 0, '2026-08-22T10:00:00Z')`,
      [MARKET, POOL, TOKEN, QUOTE, `0x${'a'.repeat(64)}`, `0x${'b'.repeat(64)}`]
    );
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('keeps the newest successful block and resets failure state', async () => {
    const repository = createRobinhoodPoolLiquiditySnapshotRepository({ database: db });
    const snapshot = (blockNumber, hash) => ({
      protocol: 'uniswap-v3', marketKey: MARKET, blockNumber, blockHash: hash,
      observedAt: '2026-08-22T11:00:00Z', checkedAt: '2026-08-22T11:00:01Z',
      liquidityUsd: '1000', liquidityRaw: '50',
      liquidityStatus: 'spot_tvl_from_pool_balances', liquidityConfidence: 'medium',
    });
    assert.equal(await repository.recordSnapshot(snapshot('20', `0x${'c'.repeat(64)}`)), true);
    assert.equal(await repository.recordSnapshot(snapshot('19', `0x${'d'.repeat(64)}`)), false);
    assert.equal(await repository.recordFailure({
      protocol: 'uniswap-v3', marketKey: MARKET,
      checkedAt: '2026-08-22T11:02:00Z',
      error: { code: 'rpc_error', message: 'temporary failure' },
    }), true);
    await assert.rejects(db.query(
      `UPDATE robinhood_pool_liquidity_snapshots SET liquidity_raw = NULL
        WHERE market_key = $1`, [MARKET]
    ), /robinhood_pool_liquidity_snapshots_protocol_metrics_check/);
    const { rows } = await db.query(
      `SELECT snapshot_block_number::text, liquidity_usd::text,
              consecutive_failures, last_error_code
         FROM robinhood_pool_liquidity_snapshots WHERE market_key = $1`, [MARKET]
    );
    assert.deepEqual(rows[0], {
      snapshot_block_number: '20', liquidity_usd: '1000',
      consecutive_failures: 1, last_error_code: 'rpc_error',
    });
    assert.equal(await repository.recordSnapshot(snapshot('21', `0x${'e'.repeat(64)}`)), true);
  });
});
