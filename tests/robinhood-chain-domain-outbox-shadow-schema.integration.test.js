'use strict';

const assert = require('node:assert/strict');
const { after, before, it } = require('node:test');
const db = require('../src/models/db');
const stage247 = require('../src/utils/db-init-stage247');
const stage248 = require('../src/utils/db-init-stage248');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { inspectRuntimeSchema } = require('../src/utils/runtime-schema');

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
  const { report } = await inspectRuntimeSchema();
  assert.equal(report.issues.some(({ key }) => key === 'stage248-robinhood-domain-outbox-shadow'), false);
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
