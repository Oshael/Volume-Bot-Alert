'use strict';

const assert = require('node:assert/strict');
const { after, before, it } = require('node:test');
const db = require('../src/models/db');
const stage253 = require('../src/utils/db-init-stage253');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const BLOCK = 70750001;
const HASH = `0x${'7'.repeat(64)}`;
const PARENT = `0x${'6'.repeat(64)}`;
const TX = `0x${'5'.repeat(64)}`;
const ADDRESS = `0x${'4'.repeat(40)}`;

before(async () => {
  await assertUsingTestDatabase(db);
  await stage253.init({ database: db, closePool: false,
    heapTablespace: 'pg_default', indexTablespace: 'pg_default',
    fromBlock: 70750000, throughBlock: 71249999 });
});

after(async () => db.pool.end());

it('creates only the requested empty partitions and rejects a different layout', async () => {
  await stage253.init({ database: db, closePool: false,
    heapTablespace: 'pg_default', indexTablespace: 'pg_default',
    fromBlock: 70750000, throughBlock: 71249999 });
  const { rows } = await db.query(`SELECT child.relname,
      pg_get_expr(child.relpartbound, child.oid) AS bound
    FROM pg_inherits inheritance
    JOIN pg_class child ON child.oid=inheritance.inhrelid
    WHERE inheritance.inhparent=$1::regclass
    ORDER BY child.relname`, [stage253.SHADOW]);
  assert.deepEqual(rows.map((row) => row.relname), [
    'robinhood_chain_transactions_shadow_b70750000',
    'robinhood_chain_transactions_shadow_b71000000',
  ]);
  assert.match(rows[0].bound, /FROM \('70750000'\) TO \('71000000'\)/);
  assert.equal((await db.query(`SELECT COUNT(*)::int AS n
    FROM public.robinhood_chain_transactions_shadow`)).rows[0].n, 0);
  assert.throws(() => stage253.cliOptions(['--from-block=1']), /required/);
  await assert.rejects(stage253.init({ database: db, closePool: false,
    heapTablespace: 'pg_default', indexTablespace: 'pg_default',
    fromBlock: 70750000, throughBlock: 76750000 }), /at most 24/);
});

it('lets partitioned event FKs reject missing transactions and cascade on reorg', async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE public.rh_tx_retention_event_probe (
      chain varchar(16) NOT NULL DEFAULT 'robinhood',
      block_number bigint NOT NULL,
      block_hash varchar(66) NOT NULL,
      transaction_hash varchar(66) NOT NULL,
      log_index integer NOT NULL,
      PRIMARY KEY (chain, block_number, block_hash, log_index),
      FOREIGN KEY (chain, block_number, block_hash, transaction_hash)
        REFERENCES public.robinhood_chain_transactions_shadow
          (chain, block_number, block_hash, transaction_hash)
        ON DELETE CASCADE
    ) PARTITION BY RANGE (block_number)`);
    await client.query(`CREATE TABLE public.rh_tx_retention_event_probe_b70750000
      PARTITION OF public.rh_tx_retention_event_probe
      FOR VALUES FROM (70750000) TO (71000000)`);
    await client.query(`INSERT INTO robinhood_chain_blocks (
      block_number, block_hash, parent_hash, capture_digest, block_timestamp,
      head_observed_at, receipts_available_at
    ) VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW())`,
    [BLOCK, HASH, PARENT, TX]);
    const insertEvent = `INSERT INTO public.rh_tx_retention_event_probe (
      block_number, block_hash, transaction_hash, log_index
    ) VALUES ($1, $2, $3, 0)`;
    await client.query('SAVEPOINT missing_transaction');
    await assert.rejects(client.query(insertEvent, [BLOCK, HASH, TX]), /foreign key/);
    await client.query('ROLLBACK TO SAVEPOINT missing_transaction');
    await client.query(`INSERT INTO public.robinhood_chain_transactions_shadow (
      block_number, block_hash, transaction_hash, transaction_index,
      from_address, receipt_succeeded
    ) VALUES ($1, $2, $3, 0, $4, TRUE)`, [BLOCK, HASH, TX, ADDRESS]);
    await client.query(insertEvent, [BLOCK, HASH, TX]);
    const placement = await client.query(`SELECT tableoid::regclass::text AS partition
      FROM public.robinhood_chain_transactions_shadow WHERE block_hash=$1`, [HASH]);
    assert.equal(placement.rows[0].partition,
      'robinhood_chain_transactions_shadow_b70750000');
    await client.query(`DELETE FROM public.robinhood_chain_transactions_shadow
      WHERE block_number=$1 AND block_hash=$2`, [BLOCK, HASH]);
    assert.equal((await client.query(`SELECT count(*)::int AS n
      FROM public.rh_tx_retention_event_probe`)).rows[0].n, 0);
    await client.query(`INSERT INTO public.robinhood_chain_transactions_shadow (
      block_number, block_hash, transaction_hash, transaction_index,
      from_address, receipt_succeeded
    ) VALUES ($1, $2, $3, 0, $4, TRUE)`, [BLOCK, HASH, TX, ADDRESS]);
    await client.query(insertEvent, [BLOCK, HASH, TX]);
    await client.query('DELETE FROM robinhood_chain_blocks WHERE block_hash=$1', [HASH]);
    assert.equal((await client.query(`SELECT count(*)::int AS n
      FROM public.robinhood_chain_transactions_shadow WHERE block_hash=$1`, [HASH])).rows[0].n, 0);
    assert.equal((await client.query(`SELECT count(*)::int AS n
      FROM public.rh_tx_retention_event_probe`)).rows[0].n, 0);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
