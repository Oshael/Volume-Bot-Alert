process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { createV4BlockedPreviewRepository } = require('../src/models/robinhood-v4-blocked-preview');
const { BLOCKED_RECOVERY_ERROR } = require('../src/models/robinhood-head-processing');

it('compares ledger/captures/processed under read-only transactions without losing numeric precision', async () => {
  await assertUsingTestDatabase(db);
  const client = await db.getClient();
  try {
    await client.query(`
      CREATE TEMP TABLE robinhood_head_captures (
        chain text, stream text, protocol text, market_key text, block_number bigint,
        block_hash text, transaction_hash text, log_index bigint, processing_status text, last_error text);
      CREATE TEMP TABLE robinhood_pool_registry (
        chain text, protocol text, market_key text, pool_id text, discovery_block bigint,
        tick_spacing int, origin_address text);
      CREATE TEMP TABLE robinhood_v4_liquidity_deltas (
        chain text, transaction_hash text, log_index bigint, block_number bigint, liquidity_delta numeric(78,0));
      CREATE TEMP TABLE robinhood_processed_logs (chain text, transaction_hash text, log_index bigint);
      CREATE TEMP TABLE robinhood_v4_liquidity_ranges (
        chain text, pool_id text, tick_lower int, tick_upper int, liquidity_gross numeric(78,0));
    `);
    await client.query(`INSERT INTO robinhood_head_captures VALUES
      ('robinhood','market','uniswap-v4','pool',12,'hash','tx',3,'blocked',$1),
      ('robinhood','market','uniswap-v4','later',99,'hash','later-tx',1,'blocked',$1)`, [BLOCKED_RECOVERY_ERROR]);
    await client.query("INSERT INTO robinhood_pool_registry VALUES ('robinhood','uniswap-v4','pool','id',10,60,'manager')");
    await client.query("INSERT INTO robinhood_v4_liquidity_deltas VALUES ('robinhood','old-tx',1,10,90071992547409931234)");
    await client.query("INSERT INTO robinhood_processed_logs VALUES ('robinhood','old-tx',1)");
    await client.query("INSERT INTO robinhood_v4_liquidity_ranges VALUES ('robinhood','id',-60,60,90071992547409931234)");
    await client.query('BEGIN READ ONLY');
    const repository = createV4BlockedPreviewRepository(client);
    const targets = await repository.targets('12');
    assert.equal(targets.length, 1);
    assert.equal(targets[0].blocked_block, '12');
    assert.equal(targets[0].discovery_block, '10');
    const found = await repository.identities([{ transactionHash: 'old-tx', logIndex: '1' },
      { transactionHash: 'tx', logIndex: '3' }, { transactionHash: 'missing', logIndex: '0' }]);
    assert.equal(found.get('old-tx:1').ledger.liquidity_delta, '90071992547409931234');
    assert.equal(found.get('old-tx:1').processed, true);
    assert.equal(found.get('tx:3').ledger, null);
    assert.equal(found.get('tx:3').capture_status, 'blocked');
    assert.equal(found.get('missing:0').processed, false);
    assert.equal((await repository.ranges('id'))[0].liquidity_gross, '90071992547409931234');
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await db.pool.end();
  }
});
