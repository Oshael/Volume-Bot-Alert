process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { fixture, AMOUNT } = require('./helpers/v4-blocked-repair-fixture');
const { repairPool } = require('../src/models/robinhood-v4-blocked-repair');
const { BLOCKED_RECOVERY_ERROR } = require('../src/models/robinhood-head-processing');
const { createRobinhoodPersistenceRepository } = require('../src/models/robinhood-persistence');
const workerLease = require('../src/models/worker-lease');

it('repairs atomically with exact balances, fences the worker, and retries without double application', async () => {
  await assertUsingTestDatabase(db);
  const client = await db.getClient();
  const { item, logs } = fixture(); const t = item.target;
  try {
    for (const stage of [63, 99, 101, 103]) {
      for (const sql of require(`../src/utils/db-init-stage${stage}`).STATEMENTS) {
        if (/^CREATE TABLE IF NOT EXISTS robinhood_(processed_logs|v4_liquidity_|head_captures)/.test(sql)) {
          await client.query(sql.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE'));
        }
      }
    }
    await client.query(`CREATE TEMP TABLE worker_leases
      (lease_key text PRIMARY KEY, lease_until timestamptz, owner_id text DEFAULT 'repair-test');
      INSERT INTO worker_leases (lease_key, lease_until)
        VALUES ('robinhood-processing-worker', NOW() + INTERVAL '1 minute');
      CREATE TEMP TABLE robinhood_pool_registry (chain text, protocol text, market_key text, pool_id text,
        discovery_block bigint, tick_spacing int, origin_address text)`);
    await client.query(`INSERT INTO robinhood_pool_registry VALUES ('robinhood','uniswap-v4',$1,$2,10,60,$3)`,
      [t.market_key, t.pool_id, t.origin_address]);
    await client.query(`INSERT INTO robinhood_v4_liquidity_materialization_state
      (chain,replay_start_block,replay_target_block,replay_checkpoint_hash) VALUES ('robinhood',0,9,$1)`, [t.block_hash]);
    for (const [i, log] of logs.entries()) {
      await client.query(`INSERT INTO robinhood_head_captures
        (chain,stream,protocol,market_key,block_number,block_hash,transaction_hash,log_index,
        transaction_index,address,topics,data,evidence,processing_status,last_error)
        VALUES ('robinhood','market','uniswap-v4',$1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,$11)`,
      [t.market_key, log.blockNumber, log.blockHash, log.transactionHash, log.logIndex, log.address,
        JSON.stringify(log.topics), log.data, JSON.stringify({ event: item.events[i] }),
        i ? 'blocked' : 'pending', i ? BLOCKED_RECOVERY_ERROR : null]);
    }
    await assert.rejects(repairPool(client, item, { write: true }), /Processing must be stopped/);
    await client.query("UPDATE worker_leases SET lease_until = NOW() - INTERVAL '1 second'");
    const empty = async () => {
      assert.equal((await client.query('SELECT count(*)::int AS n FROM robinhood_v4_liquidity_deltas')).rows[0].n, 0);
      assert.equal((await client.query('SELECT count(*)::int AS n FROM robinhood_processed_logs')).rows[0].n, 0);
      assert.equal((await client.query('SELECT count(*)::int AS n FROM robinhood_v4_liquidity_ranges')).rows[0].n, 0);
      assert.equal((await client.query('SELECT processing_status FROM robinhood_head_captures WHERE log_index=3')).rows[0].processing_status, 'blocked');
    };
    assert.equal((await repairPool(client, item)).status, 'validated'); await empty();
    assert.equal(await workerLease.release('robinhood-processing-worker', 'repair-test', client), true);
    assert.equal((await client.query('SELECT * FROM worker_leases')).rowCount, 0);
    assert.equal((await repairPool(client, item)).status, 'validated'); await empty();
    await assert.rejects(repairPool(client, item, { write: true,
      verifyCanonical: async () => { throw new Error('Canonical block mismatch'); } }), /Canonical/);
    await empty();
    await client.query(`INSERT INTO robinhood_v4_liquidity_ranges
      (chain,pool_id,market_key,tick_lower,tick_upper,liquidity_gross) VALUES ('robinhood',$1,$2,-60,60,1)`,
    [t.pool_id, t.market_key]);
    await assert.rejects(repairPool(client, item, { write: true }), /Materialized balance/);
    await client.query('TRUNCATE pg_temp.robinhood_v4_liquidity_ranges');
    await client.query(`UPDATE robinhood_head_captures SET evidence =
      jsonb_set(evidence, '{event,liquidityDelta}', '"-1"') WHERE log_index=3`);
    await assert.rejects(repairPool(client, item, { write: true }), /Capture conflict/);
    await empty();
    await client.query('UPDATE robinhood_head_captures SET evidence=$1 WHERE log_index=3',
      [JSON.stringify({ event: item.events[1] })]);
    assert.equal((await repairPool(client, item, { write: true })).inserted, 1);
    assert.equal((await repairPool(client, item, { write: true })).status, 'already-repaired');
    assert.equal((await client.query('SELECT liquidity_gross::text AS n FROM robinhood_v4_liquidity_ranges')).rows[0].n, AMOUNT);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM robinhood_processed_logs')).rows[0].n, 1);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM robinhood_v4_liquidity_deltas')).rows[0].n, 1);
    assert.equal((await client.query('SELECT processing_status FROM robinhood_head_captures WHERE log_index=3')).rows[0].processing_status, 'pending');
    // Exercise the real live persistence path: predecessor deduplicates, withdrawal now succeeds.
    const live = createRobinhoodPersistenceRepository({ database: {
      getClient: async () => ({ query: client.query.bind(client), release() {} }),
    } });
    const commit = await live.commitHeadProcessingBatch({ entries: logs.map((log, i) => ({ log, event: item.events[i] })) });
    assert.equal(commit.duplicateLogs, 1);
    assert.equal(commit.insertedLiquidityDeltas, 1);
    assert.equal((await client.query('SELECT liquidity_gross::text AS n FROM robinhood_v4_liquidity_ranges')).rows[0].n, '0');
    assert.equal((await repairPool(client, item, { write: true })).status, 'already-repaired');
  } finally { await client.query('ROLLBACK'); client.release(); await db.pool.end(); }
});
