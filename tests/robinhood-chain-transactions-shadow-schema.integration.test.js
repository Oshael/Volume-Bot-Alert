'use strict';

const assert = require('node:assert/strict');
const { after, before, it } = require('node:test');
const db = require('../src/models/db');
const stage253 = require('../src/utils/db-init-stage253');
const eventFks = require('../src/utils/migrate-robinhood-chain-transaction-event-fks');
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

it('verifies the requested empty partitions and rejects a different layout', async () => {
  await stage253.init({ database: db, closePool: false,
    heapTablespace: 'pg_default', indexTablespace: 'pg_default',
    fromBlock: 70750000, throughBlock: 71249999 });
  const { rows } = await db.query(`SELECT child.relname,
      pg_get_expr(child.relpartbound, child.oid) AS bound
    FROM pg_inherits inheritance
    JOIN pg_class child ON child.oid=inheritance.inhrelid
    WHERE inheritance.inhparent=$1::regclass
      AND child.relname=ANY($2::text[])
    ORDER BY child.relname`, [stage253.SHADOW, [
      'robinhood_chain_transactions_shadow_b70750000',
      'robinhood_chain_transactions_shadow_b71000000',
    ]]);
  assert.deepEqual(rows.map((row) => row.relname), [
    'robinhood_chain_transactions_shadow_b70750000',
    'robinhood_chain_transactions_shadow_b71000000',
  ]);
  assert.match(rows[0].bound, /FROM \('70750000'\) TO \('71000000'\)/);
  const indexes = await db.query(`SELECT parent_index.relname AS parent_name,
      pg_get_indexdef(child_index.oid) AS definition
    FROM pg_inherits inheritance
    JOIN pg_class child_index ON child_index.oid=inheritance.inhrelid
    JOIN pg_class parent_index ON parent_index.oid=inheritance.inhparent
    JOIN pg_index state ON state.indexrelid=child_index.oid
    WHERE state.indrelid='public.robinhood_chain_transactions_shadow_b70750000'::regclass`);
  const byName = new Map(indexes.rows.map((row) => [row.parent_name, row.definition]));
  assert.equal(byName.size, 4);
  assert.match(byName.get('idx_rh_chain_transactions_shadow_hash'),
    /\(chain, block_hash, transaction_hash\)/);
  assert.match(byName.get('idx_rh_chain_transactions_shadow_txhash'),
    /\(chain, transaction_hash, block_hash\)/);
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

it('prepares and validates one leaf FK while the legacy FK remains active', async () => {
  const client = await db.getClient();
  const leaf = 'public.rh_tx_fk_test_events_b70750000';
  const options = { oldName: 'rh_tx_fk_test_old', newName: 'rh_tx_fk_test_new' };
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE public.rh_tx_fk_test_events (
      chain varchar(16) NOT NULL DEFAULT 'robinhood',
      block_number bigint NOT NULL, block_hash varchar(66) NOT NULL,
      transaction_hash varchar(66) NOT NULL,
      CONSTRAINT rh_tx_fk_test_old FOREIGN KEY (chain, block_hash, transaction_hash)
        REFERENCES public.robinhood_chain_transactions
          (chain, block_hash, transaction_hash) ON DELETE CASCADE
    ) PARTITION BY RANGE (block_number)`);
    await client.query(`CREATE TABLE ${leaf} PARTITION OF public.rh_tx_fk_test_events
      FOR VALUES FROM (70750000) TO (71000000)`);
    await client.query(`INSERT INTO robinhood_chain_blocks (
      block_number, block_hash, parent_hash, capture_digest, block_timestamp,
      head_observed_at, receipts_available_at
    ) VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW())`,
    [BLOCK, HASH, PARENT, TX]);
    await client.query(`INSERT INTO robinhood_chain_transactions (
      block_hash, transaction_hash, transaction_index, from_address, receipt_succeeded
    ) VALUES ($1, $2, 0, $3, TRUE)`, [HASH, TX, ADDRESS]);
    await client.query(`INSERT INTO public.rh_tx_fk_test_events (
      block_number, block_hash, transaction_hash
    ) VALUES ($1, $2, $3)`, [BLOCK, HASH, TX]);
    assert.deepEqual(await eventFks.inspectLeaf(client, leaf, options), {
      partition: leaf, prepared: false, validated: false,
    });
    assert.equal((await eventFks.prepareLeaf(client, leaf, options)).prepared, true);
    assert.equal((await eventFks.prepareLeaf(client, leaf, options)).validated, false);
    await client.query('SAVEPOINT missing_shadow_transaction');
    await assert.rejects(eventFks.validateLeaf(client, leaf, options), /foreign key/);
    await client.query('ROLLBACK TO SAVEPOINT missing_shadow_transaction');
    await client.query(`INSERT INTO robinhood_chain_transactions_shadow (
      block_number, block_hash, transaction_hash, transaction_index,
      from_address, receipt_succeeded
    ) VALUES ($1, $2, $3, 0, $4, TRUE)`, [BLOCK, HASH, TX, ADDRESS]);
    assert.equal((await eventFks.validateLeaf(client, leaf, options)).validated, true);
    assert.equal((await eventFks.validateLeaf(client, leaf, options)).validated, true);
    await client.query(`DELETE FROM robinhood_chain_transactions_shadow
      WHERE block_number=$1 AND block_hash=$2`, [BLOCK, HASH]);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${leaf}`)).rows[0].n, 0);
    assert.equal((await client.query(`SELECT count(*)::int AS n
      FROM robinhood_chain_transactions WHERE block_hash=$1`, [HASH])).rows[0].n, 1);
    assert.deepEqual(eventFks.parseArgs(['--partition-start=70750000', '--prepare']),
      { action: 'prepare', partitionStart: 70750000 });
    assert.deepEqual(eventFks.parseArgs([
      '--partition-start=70750000', '--prepare', '--paused',
      '--expected-next-block=70750002',
    ]), { action: 'prepare', partitionStart: 70750000,
      paused: true, expectedNextBlock: 70750002 });
    assert.throws(() => eventFks.parseArgs([
      '--partition-start=70750000', '--prepare', '--paused',
      '--expected-next-block=71000000',
    ]), /expected next block in the partition/);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

it('requires an inactive capture lease and an exact stopped cursor for the active leaf', async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO robinhood_chain_capture_cursor
      (chain, next_block, checkpoint_block, checkpoint_hash, node_head,
       finalized_head, recovery_state)
      VALUES ('robinhood', 70750002, 70750001, $1, 70750001, 70750001, 'running')
      ON CONFLICT (chain) DO UPDATE SET next_block=EXCLUDED.next_block,
        checkpoint_block=EXCLUDED.checkpoint_block,
        checkpoint_hash=EXCLUDED.checkpoint_hash, node_head=EXCLUDED.node_head,
        finalized_head=EXCLUDED.finalized_head, recovery_state='running',
        recovery_plan=NULL, recovery_detected_at=NULL`, [HASH]);
    const options = { leaseKey: 'rh-tx-fk-test-capture-lease' };
    assert.equal(await eventFks.assertCapturePaused(client, 70750000, 70750002, options),
      '70750002');
    await assert.rejects(eventFks.assertCapturePaused(client, 70750000, 70750003, options),
      /checkpoint differs/);
    await client.query(`INSERT INTO worker_leases (lease_key, owner_id, lease_until)
      VALUES ($1, 'rh-tx-fk-test', NOW()+INTERVAL '1 minute')`, [options.leaseKey]);
    await assert.rejects(eventFks.assertCapturePaused(client, 70750000, 70750002, options),
      /capture is active/);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
