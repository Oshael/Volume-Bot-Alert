process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage63 = require('../src/utils/db-init-stage63');
const stage64 = require('../src/utils/db-init-stage64');
const stage65 = require('../src/utils/db-init-stage65');
const stage66 = require('../src/utils/db-init-stage66');
const stage67 = require('../src/utils/db-init-stage67');
const stage68 = require('../src/utils/db-init-stage68');
const stage98 = require('../src/utils/db-init-stage98');
const stage99 = require('../src/utils/db-init-stage99');
const stage100 = require('../src/utils/db-init-stage100');
const stage102 = require('../src/utils/db-init-stage102');
const stage147 = require('../src/utils/db-init-stage147');
const stage148 = require('../src/utils/db-init-stage148');
const stage150 = require('../src/utils/db-init-stage150');
const {
  createRobinhoodPoolLiquiditySeedRepository,
} = require('../src/models/robinhood-pool-liquidity-seed');
const {
  createRobinhoodPoolLiquiditySnapshotRepository,
} = require('../src/models/robinhood-pool-liquidity-snapshot');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { Pool } = require('pg');
const { createLiquidityTimedDatabase } = require('../src/utils/robinhood-liquidity-db-timing');
const { createLiquidityHistoricalRangeRepository } = require('../src/models/robinhood-liquidity-historical-ranges');
const { createRobinhoodPersistenceRepository } = require('../src/models/robinhood-persistence');
const v2 = require('../src/services/uniswap-v2-decoder');
const v3 = require('../src/services/uniswap-v3-decoder');
const v4 = require('../src/services/uniswap-v4-decoder');
const { V4_DONATE_TOPIC } = require('../src/services/robinhood-pool-liquidity-events');

const POOL = `0x${'7'.repeat(40)}`;
const TOKEN = `0x${'8'.repeat(40)}`;
const QUOTE = `0x${'9'.repeat(40)}`;
const MARKET = `robinhood:uniswap-v3:${POOL}`;

async function cleanup() {
  await db.query("DELETE FROM robinhood_pool_liquidity_event_cursors WHERE chain = 'robinhood'");
  await db.query('DELETE FROM robinhood_market_buckets_1m WHERE market_key = $1', [MARKET]);
  await db.query('DELETE FROM robinhood_pool_registry WHERE market_key = $1', [MARKET]);
  await db.query("DELETE FROM token_catalog WHERE chain = 'robinhood' AND address = $1", [TOKEN]);
}

describe('Robinhood pool liquidity snapshot persistence integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage63.init({ closePool: false });
    await stage64.init({ closePool: false });
    await stage65.init({ closePool: false });
    await stage66.init({ closePool: false });
    await stage67.init({ closePool: false });
    await stage68.init({ closePool: false });
    await stage98.init({ closePool: false });
    await stage99.init({ closePool: false });
    await stage100.init({ closePool: false });
    await stage102.init({ closePool: false });
    await stage147.init({ closePool: false });
    await stage147.init({ closePool: false });
    await stage148.init({ closePool: false });
    await stage150.init({ closePool: false });
    await stage150.init({ closePool: false });
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
    await db.query(
      `INSERT INTO token_catalog (chain, address, source)
       VALUES ('robinhood', $1, 'robinhood-onchain')`, [TOKEN]
    );
    await db.query(
      `INSERT INTO robinhood_market_buckets_1m (
         protocol, market_key, token_address, quote_address, bucket_ts,
         open_price_usd, high_price_usd, low_price_usd, close_price_usd,
         open_fdv_usd, high_fdv_usd, low_fdv_usd, close_fdv_usd,
         volume_usd, swaps, buys, sells, transactions,
         first_observed_at, first_block_number, first_log_index,
         last_observed_at, last_block_number, last_log_index, expires_at,
         close_liquidity_usd, close_liquidity_raw, close_liquidity_status,
         close_liquidity_confidence
       ) VALUES ('uniswap-v3', $1, $2, $3, '2026-08-22T11:00:00Z',
         1, 1, 1, 1, 100, 100, 100, 100, 1, 1, 1, 0, 1,
         '2026-08-22T11:00:01Z', 22, 0, '2026-08-22T11:00:01Z', 22, 0,
         '2026-09-05T11:00:00Z', 1200, 60,
         'spot_tvl_from_pool_balances', 'medium')`, [MARKET, TOKEN, QUOTE]
    );
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('selects each affected active pool once and verifies the V4 manager', async () => {
    const client = await db.getClient();
    const repository = createRobinhoodPoolLiquiditySnapshotRepository({ database: client });
    const manager = `0x${'4'.repeat(40)}`;
    const otherManager = `0x${'5'.repeat(40)}`;
    const fixtures = [
      { protocol: 'uniswap-v2', address: `0x${'6'.repeat(40)}`, active: true },
      { protocol: 'uniswap-v3', address: `0x${'d'.repeat(40)}`, active: false },
      { protocol: 'uniswap-v4', id: `0x${'1'.repeat(64)}`, active: true },
      { protocol: 'uniswap-v4', id: `0x${'2'.repeat(64)}`, active: true },
      { protocol: 'uniswap-v4', id: `0x${'3'.repeat(64)}`, active: false },
      { protocol: 'uniswap-v4', id: `0x${'4'.repeat(64)}`, active: true },
    ].map((pool) => ({ ...pool, key: `robinhood:${pool.protocol}:${pool.address || pool.id}` }));
    try {
      await client.query('BEGIN');
      for (const pool of fixtures) {
        await client.query(
          `INSERT INTO robinhood_pool_registry (
             protocol, market_key, pool_address, pool_id, origin_address, token_address,
             quote_address, currency0, currency1, discovery_block, discovery_block_hash,
             discovery_tx_hash, discovery_log_index, discovered_at, active
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $6, $7, 10, $8, $9, 0,
             '2026-08-22T10:00:00Z', $10)`,
          [pool.protocol, pool.key, pool.address || null, pool.id || null,
            pool.address || manager, TOKEN, QUOTE,
            `0x${'a'.repeat(64)}`, `0x${'b'.repeat(64)}`, pool.active]
        );
      }
      await repository.recordFailure({
        protocol: 'uniswap-v4', marketKey: fixtures[2].key,
        error: { code: 'rpc_error', message: 'fixture failure' },
      });
      const addressLogs = [
        { address: fixtures[0].address, topics: [v2.TOPICS.sync] },
        { address: fixtures[1].address, topics: [v3.TOPICS.swap] },
        { address: `0x${'e'.repeat(40)}`, topics: [v2.TOPICS.sync] },
        ...['a', 'b'].map((sender) => ({
          address: POOL, topics: [v3.TOPICS.swap, `0x${sender.repeat(64)}`],
        })),
      ];
      const v4Logs = [
        { address: manager, topics: [v4.TOPICS.swap, fixtures[2].id] },
        { address: manager, topics: [v4.TOPICS.modifyLiquidity, fixtures[2].id] },
        { address: manager, topics: [V4_DONATE_TOPIC, fixtures[3].id] },
        { address: manager, topics: [v4.TOPICS.swap, fixtures[4].id] },
        { address: otherManager, topics: [v4.TOPICS.swap, fixtures[2].id] },
        { address: otherManager, topics: [v4.TOPICS.swap, fixtures[5].id] },
      ];
      const addressKeys = [fixtures[0].key, MARKET];
      const v4Keys = [fixtures[2].key, fixtures[3].key];
      for (const [logs, expected] of [
        [addressLogs, addressKeys], [v4Logs, v4Keys],
        [[...addressLogs, ...v4Logs], [...addressKeys, ...v4Keys]],
      ]) {
        const pools = await repository.listPoolsForLiquidityEvents(logs);
        assert.deepEqual(pools.map(({ marketKey }) => marketKey), expected);
        for (const pool of pools) {
          assert.equal(pool.tokenAddress, TOKEN);
          assert.equal(pool.consecutiveFailures, pool.marketKey === fixtures[2].key ? 1 : 0);
        }
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('commits batches atomically while preserving newer snapshots and inactive pools', async () => {
    const client = await db.getClient();
    const repository = createRobinhoodPoolLiquiditySnapshotRepository({ database: client });
    const extra = `robinhood:uniswap-v3:0x${'c'.repeat(40)}`;
    const inactive = `robinhood:uniswap-v3:0x${'d'.repeat(40)}`;
    const batchKeys = [MARKET, extra, ...Array.from({ length: 98 }, (_, i) =>
      `robinhood:uniswap-v3:0x${(i + 1).toString(16).padStart(40, '0')}`)];
    const snapshot = (marketKey, blockNumber) => ({
      protocol: 'uniswap-v3', marketKey, blockNumber, blockHash: `0x${'c'.repeat(64)}`,
      observedAt: '2026-08-22T11:00:00Z', checkedAt: '2026-08-22T11:00:01Z',
      liquidityUsd: '42', liquidityRaw: '9',
      liquidityStatus: 'spot_tvl_from_pool_balances', liquidityConfidence: 'medium',
    });
    try {
      await client.query('BEGIN');
      for (const key of [extra, inactive, ...batchKeys.slice(2)]) {
        await client.query(
          `INSERT INTO robinhood_pool_registry (
             protocol, market_key, pool_address, origin_address, token_address,
             quote_address, currency0, currency1, discovery_block,
             discovery_block_hash, discovery_tx_hash, discovery_log_index, discovered_at, active
           ) SELECT protocol, $2, $3, origin_address, token_address,
                    quote_address, currency0, currency1, discovery_block,
                    discovery_block_hash, discovery_tx_hash, discovery_log_index, discovered_at, $4
             FROM robinhood_pool_registry WHERE market_key = $1`,
          [MARKET, key, key.split(':')[2], key !== inactive]
        );
      }
      assert.equal(await repository.recordSnapshots([
        snapshot(MARKET, '30'), snapshot(extra, '30'), snapshot(inactive, '30'),
      ]), 2);
      await repository.recordFailure({
        protocol: 'uniswap-v3', marketKey: MARKET,
        error: { code: 'rpc_error', message: 'fixture failure' },
      });
      assert.equal(await repository.recordSnapshots([
        snapshot(MARKET, '29'), snapshot(extra, '31'),
      ]), 1);
      const readRows = () => client.query(
        `SELECT market_key, snapshot_block_number::text AS block, consecutive_failures
           FROM robinhood_pool_liquidity_snapshots
          WHERE market_key = ANY($1::varchar[]) ORDER BY market_key`,
        [[MARKET, extra, inactive]]
      );
      const expected = [
        { market_key: MARKET, block: '30', consecutive_failures: 1 },
        { market_key: extra, block: '31', consecutive_failures: 0 },
      ];
      assert.deepEqual((await readRows()).rows, expected);
      await client.query('SAVEPOINT invalid_batch');
      await assert.rejects(repository.recordSnapshots(batchKeys.map((key, i) =>
        snapshot(key, i === 99 ? '9223372036854775808' : '32'))), (error) => error.code === '22003');
      await client.query('ROLLBACK TO SAVEPOINT invalid_batch');
      assert.deepEqual((await readRows()).rows, expected);
      const replay = batchKeys.map((key) => snapshot(key, '32'));
      assert.equal(await repository.recordSnapshots(replay), 100);
      assert.equal(await repository.recordSnapshots(replay), 100);
      assert.deepEqual((await readRows()).rows, expected.map((row) => ({
        ...row, block: '32', consecutive_failures: 0,
      })));
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('matches individual historical V4 reads at exact boundaries and replay readiness', async () => {
    const client = await db.getClient();
    const batchReader = createLiquidityHistoricalRangeRepository({ database: client });
    const singleReader = createRobinhoodPersistenceRepository({ database: client });
    const ids = ['c', 'd', 'e'].map((char) => `0x${char.repeat(64)}`);
    try {
      await client.query('BEGIN');
      await client.query("DELETE FROM robinhood_v4_liquidity_deltas WHERE pool_id = ANY($1::text[])", [ids]);
      await client.query("DELETE FROM robinhood_v4_liquidity_replay_state WHERE chain = 'robinhood'");
      await client.query(`INSERT INTO robinhood_v4_liquidity_replay_state
        (chain, start_block, next_block, target_block, status)
        VALUES ('robinhood', 0, 201, 200, 'completed')`);
      const deltas = [
        [ids[0], 10, 0, '90071992547409930000', -60], [ids[0], 20, 0, '-20', -60],
        [ids[0], 20, 1, '500', -60], [ids[0], 21, 0, '1000', -60],
        [ids[0], 10, 1, '-1', 0], [ids[1], 5, 0, '40', -60], [ids[1], 9, 0, '-40', -60],
      ];
      for (const [index, [id, block, log, delta, lower]] of deltas.entries()) {
        await client.query(`INSERT INTO robinhood_v4_liquidity_deltas (
          transaction_hash, log_index, block_number, block_hash, pool_id, market_key,
          sender, tick_lower, tick_upper, liquidity_delta, salt, observed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 60, $9, $4, NOW())`,
        [`0x${(index + 1).toString(16).padStart(64, 'f')}`, log, block, `0x${'a'.repeat(64)}`,
          id, `robinhood:uniswap-v4:${id}`, POOL, lower, delta]);
      }
      for (const [block, log] of [['20', '0'], ['20', '1'], ['20', '2'], ['21', '0'], ['22', '0']]) {
        const actual = await batchReader.listHistoricalV4LiquidityRangesByPoolIds(ids, block, log);
        for (const id of ids) {
          assert.deepEqual(actual.get(id), await singleReader.listHistoricalV4LiquidityRanges(id, block, log));
        }
      }
      const atTwenty = await batchReader.listHistoricalV4LiquidityRangesByPoolIds(ids, '20', '1');
      assert.equal(atTwenty.get(ids[0])[0].liquidity_gross, '90071992547409929980');
      assert.deepEqual(atTwenty.get(ids[1]), []);
      assert.deepEqual(atTwenty.get(ids[2]), []);
      const fullBatch = [...ids, ...Array.from({ length: 97 }, (_, i) => `0x${i.toString(16).padStart(64, '0')}`)];
      const fullResult = await batchReader.listHistoricalV4LiquidityRangesByPoolIds(fullBatch, '20', '1');
      assert.equal(fullResult.size, 100);
      for (const id of ids) assert.deepEqual(fullResult.get(id), atTwenty.get(id));
      await client.query("UPDATE robinhood_v4_liquidity_replay_state SET status = 'running', next_block = 200");
      assert.deepEqual([...(await batchReader.listHistoricalV4LiquidityRangesByPoolIds(ids, '20', '1')).values()],
        [null, null, null]);
      await client.query("DELETE FROM robinhood_v4_liquidity_replay_state WHERE chain = 'robinhood'");
      assert.deepEqual([...(await batchReader.listHistoricalV4LiquidityRangesByPoolIds(ids, '20', '1')).values()],
        [null, null, null]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('observes real pool contention and releases connections after PostgreSQL errors', async () => {
    const pool = new Pool({ ...db.pool.options, password: db.pool.options.password, max: 1 });
    const events = [];
    const timed = createLiquidityTimedDatabase({ pool }, {
      slowQueryMs: 0, emit: (event) => events.push(event),
    });
    let held;
    let pending;
    try {
      held = await pool.connect();
      pending = timed.query('SELECT pg_backend_pid() AS pid, $1::text AS value', ['exact-value']);
      assert.equal(pool.waitingCount, 1);
      held.release();
      held = null;
      const { rows } = await pending;
      assert.equal(rows[0].value, 'exact-value');
      assert.equal(events[0].backendPid, rows[0].pid);
      assert.equal(events[0].poolWhileAcquiring.waiting, 1);
      assert.equal(pool.waitingCount, 0);
      assert.equal(pool.idleCount, 1);
      await assert.rejects(timed.query('SELECT 1 / 0'), (error) => error.code === '22012');
      assert.equal(events[1].errorCode, '22012');
      assert.equal(events[1].failed, true);
      assert.equal((await timed.query('SELECT 42 AS value')).rows[0].value, 42);
      assert.equal(pool.waitingCount, 0);
      assert.equal(pool.idleCount, 1);
    } finally {
      held?.release();
      await pending?.catch(() => {});
      await pool.end();
    }
  });

  it('keeps the newest successful block and resets failure state', async () => {
    const index = await db.query(
      `SELECT indisvalid, indisready
         FROM pg_index
        WHERE indexrelid = to_regclass($1)`,
      [stage150.INDEX_NAME]
    );
    assert.deepEqual(index.rows[0], { indisvalid: true, indisready: true });
    const repository = createRobinhoodPoolLiquiditySnapshotRepository({ database: createLiquidityTimedDatabase(db) });
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
    const invalidated = await repository.invalidateSnapshotsFromBlock({ rewindBlock: '21' });
    assert.equal(invalidated.length, 1);
    const cleared = await db.query(
      `SELECT snapshot_block_number, liquidity_usd, consecutive_failures
         FROM robinhood_pool_liquidity_snapshots WHERE market_key = $1`, [MARKET]
    );
    assert.deepEqual(cleared.rows[0], {
      snapshot_block_number: null, liquidity_usd: null, consecutive_failures: 0,
    });
    const seedRepository = createRobinhoodPoolLiquiditySeedRepository({ database: db });
    const candidates = await seedRepository.listCandidates({ throughBlock: '22' });
    assert.deepEqual(candidates.map(({ marketKey, blockNumber }) => ({ marketKey, blockNumber })), [
      { marketKey: MARKET, blockNumber: '22' },
    ]);
    assert.deepEqual(await seedRepository.commitSeed({
      startBlock: '23', rows: [{
        protocol: 'uniswap-v3', market_key: MARKET, block_number: '22',
        block_hash: `0x${'f'.repeat(64)}`, observed_at: '2026-08-22T11:03:00Z',
        liquidity_usd: '1200', liquidity_raw: '60',
        liquidity_status: 'spot_tvl_from_pool_balances',
        liquidity_confidence: 'medium', liquidity_warning: null,
      }],
    }), { written: 1, startBlock: '23' });
    const seeded = await db.query(
      `SELECT snapshot.snapshot_block_number::text, snapshot.liquidity_usd::text,
              cursor.next_block::text
         FROM robinhood_pool_liquidity_snapshots snapshot
         CROSS JOIN robinhood_pool_liquidity_event_cursors cursor
        WHERE snapshot.market_key = $1`, [MARKET]
    );
    assert.deepEqual(seeded.rows[0], {
      snapshot_block_number: '22', liquidity_usd: '1200', next_block: '23',
    });
  });
});
