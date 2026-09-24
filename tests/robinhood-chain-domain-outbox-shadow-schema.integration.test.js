'use strict';

const assert = require('node:assert/strict');
const { after, before, it } = require('node:test');
const db = require('../src/models/db');
const stage247 = require('../src/utils/db-init-stage247');
const stage248 = require('../src/utils/db-init-stage248');
const { cutover, inspect } = require('../src/utils/cutover-robinhood-chain-domain-outbox');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const BLOCK = `0x${'b'.repeat(64)}`;
const PARENT = `0x${'c'.repeat(64)}`;
const TX = `0x${'d'.repeat(64)}`;
const ADDRESS = `0x${'a'.repeat(40)}`;
const TOPIC = `0x${'1'.repeat(64)}`;

before(async () => {
  await assertUsingTestDatabase(db);
  await stage247.init({ database: db, closePool: false, tablespace: 'pg_default',
    fromBlock: 0, throughBlock: 249999 });
  await stage248.init({ database: db, closePool: false, tablespace: 'pg_default' });
});

after(async () => db.pool.end());

it('creates an empty candidate with the exact FK to shadow events', async () => {
  await stage248.init({ database: db, closePool: false, tablespace: 'pg_default' });
  const count = await db.query('SELECT count(*)::int AS n FROM robinhood_chain_domain_outbox_shadow');
  assert.equal(count.rows[0].n, 0);
  const client = await db.getClient();
  try {
    await stage248.verify(client, 'pg_default');
  } finally {
    client.release();
  }
  await db.query(`INSERT INTO robinhood_chain_blocks (
      block_number, block_hash, parent_hash, capture_digest, block_timestamp,
      head_observed_at, receipts_available_at
    ) VALUES (123458, $1, $2, $3, NOW(), NOW(), NOW())`, [BLOCK, PARENT, TX]);
  try {
    await db.query(`INSERT INTO robinhood_chain_transactions (
        block_hash, transaction_hash, transaction_index, from_address, receipt_succeeded
      ) VALUES ($1, $2, 0, $3, TRUE)`, [BLOCK, TX, ADDRESS]);
    await db.query(`INSERT INTO robinhood_chain_events_shadow (
        block_hash, block_number, transaction_hash, transaction_index, log_index,
        address, topic0, topics, data
      ) VALUES ($1, 123458, $2, 0, 1, $3, $4, $5::jsonb, '0x')`,
    [BLOCK, TX, ADDRESS, TOPIC, JSON.stringify([TOPIC])]);
    const insert = `INSERT INTO robinhood_chain_domain_outbox_shadow (
      domain, block_hash, block_number, transaction_index, log_index
    ) VALUES ($3, $1, $2, 0, 1)`;
    await db.query(insert, [BLOCK, 123458, 'market']);
    await assert.rejects(db.query(insert, [BLOCK, 123459, 'discovery']), /foreign key/);
  } finally {
    await db.query('DELETE FROM robinhood_chain_blocks WHERE block_hash=$1', [BLOCK]);
  }
});

it('moves open outbox rows under lock and rolls the destructive swap back in the test', async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO robinhood_chain_blocks (
      block_number, block_hash, parent_hash, capture_digest, block_timestamp,
      head_observed_at, receipts_available_at
    ) VALUES (123459, $1, $2, $3, NOW(), NOW(), NOW())`, [BLOCK, PARENT, TX]);
    await client.query(`INSERT INTO robinhood_chain_transactions (
      block_hash, transaction_hash, transaction_index, from_address, receipt_succeeded
    ) VALUES ($1, $2, 0, $3, TRUE)`, [BLOCK, TX, ADDRESS]);
    for (const table of ['robinhood_chain_events', 'robinhood_chain_events_shadow']) {
      await client.query(`INSERT INTO ${table} (
        block_hash, block_number, transaction_hash, transaction_index, log_index,
        address, topic0, topics, data
      ) VALUES ($1, 123459, $2, 0, 1, $3, $4, $5::jsonb, '0x'),
               ($1, 123459, $2, 0, 2, $3, $4, $5::jsonb, '0x')`,
      [BLOCK, TX, ADDRESS, TOPIC, JSON.stringify([TOPIC])]);
    }
    await client.query(`INSERT INTO robinhood_chain_domain_outbox (
      domain, block_hash, block_number, transaction_index, log_index, status, completed_at
    ) VALUES ('market', $1, 123459, 0, 1, 'pending', NULL),
             ('market', $1, 123459, 0, 2, 'complete', NOW())`, [BLOCK]);
    await client.query('LOCK TABLE robinhood_chain_events IN SHARE ROW EXCLUSIVE MODE');
    await client.query(`LOCK TABLE robinhood_chain_domain_outbox,
      robinhood_chain_domain_outbox_shadow IN ACCESS EXCLUSIVE MODE`);
    assert.equal((await inspect(client)).openRows, 1);
    const result = await cutover(client);
    assert.equal(result.copied, 1);
    const active = await client.query(`SELECT log_index, status FROM robinhood_chain_domain_outbox`);
    assert.deepEqual(active.rows, [{ log_index: 1, status: 'pending' }]);
    assert.deepEqual(await inspect(client), { alreadyMigrated: true });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  const restored = await db.query(`SELECT to_regclass('public.robinhood_chain_domain_outbox_shadow')
    IS NOT NULL AS candidate_restored`);
  assert.equal(restored.rows[0].candidate_restored, true);
});
