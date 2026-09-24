'use strict';

const assert = require('node:assert/strict');
const { after, before, it } = require('node:test');
const db = require('../src/models/db');
const stage247 = require('../src/utils/db-init-stage247');
const backfill = require('../src/utils/backfill-robinhood-v3-snapshot-block-numbers');
const shadowCopy = require('../src/utils/copy-robinhood-chain-event-shadow-page');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { SCHEMA_GROUPS, inspectRuntimeSchema } = require('../src/utils/runtime-schema');

const HASH = `0x${'f'.repeat(63)}e`;
const TX = `0x${'e'.repeat(64)}`;
const PARENT = `0x${'d'.repeat(64)}`;
const ADDRESS = `0x${'a'.repeat(40)}`;
const TOKEN = `0x${'b'.repeat(40)}`;
const QUOTE = `0x${'c'.repeat(40)}`;
const TOPIC = `0x${'1'.repeat(64)}`;

before(async () => {
  await assertUsingTestDatabase(db);
  await stage247.init({ database: db, closePool: false, tablespace: 'pg_default',
    fromBlock: 0, throughBlock: 499999 });
});

after(async () => {
  await db.pool.end();
});

it('creates only the requested empty ranges and preserves their tablespace', async () => {
  const { rows } = await db.query(`SELECT child.relname,
      pg_get_expr(child.relpartbound, child.oid) AS bound,
      COALESCE(space.spcname, 'pg_default') AS tablespace,
      child.reltuples::bigint AS estimated_rows
    FROM pg_inherits inheritance
    JOIN pg_class child ON child.oid = inheritance.inhrelid
    LEFT JOIN pg_tablespace space ON space.oid = child.reltablespace
    WHERE inheritance.inhparent = 'public.robinhood_chain_events_shadow'::regclass
    ORDER BY child.relname`);
  assert.deepEqual(rows.map(({ relname, tablespace }) => ({ relname, tablespace })), [
    { relname: 'robinhood_chain_events_shadow_b0', tablespace: 'pg_default' },
    { relname: 'robinhood_chain_events_shadow_b250000', tablespace: 'pg_default' },
  ]);
  assert.match(rows[0].bound, /FROM \('0'\) TO \('250000'\)/);
  assert.match(rows[1].bound, /FROM \('250000'\) TO \('500000'\)/);
  const count = await db.query('SELECT count(*)::integer AS n FROM robinhood_chain_events_shadow');
  assert.equal(count.rows[0].n, 0);
  await stage247.init({ database: db, closePool: false, tablespace: 'pg_default',
    fromBlock: 0, throughBlock: 499999 });
  assert.equal(stage247.partitionRanges(249999, 250000).length, 2);
  assert.throws(() => stage247.partitionRanges(0, 24 * 250000), /at most 24/);
  assert.throws(() => stage247.tablespaceName('pg_default; DROP TABLE x'),
    /tablespace must be/);
  assert.match(stage247.shadowStatements('trendscope_raw')[0],
    /USING INDEX TABLESPACE trendscope_raw/);
  const group = SCHEMA_GROUPS.find(({ key }) => key === 'stage247-robinhood-chain-events-shadow');
  assert.equal(group.tables[1].columns[0], 'block_number');
  const { report } = await inspectRuntimeSchema();
  assert.equal(report.issues.some(({ key }) => key === group.key), false);
});

it('fills one V3 page from the authoritative event and rejects a wrong block', async () => {
  await db.query(`INSERT INTO robinhood_chain_blocks (
      block_number, block_hash, parent_hash, capture_digest, block_timestamp,
      head_observed_at, receipts_available_at
    ) VALUES (123456, $1, $2, $3, NOW(), NOW(), NOW())`, [HASH, PARENT, TX]);
  try {
    await db.query(`INSERT INTO robinhood_chain_transactions (
      block_hash, transaction_hash, transaction_index, from_address, receipt_succeeded
    ) VALUES ($1, $2, 0, $3, TRUE)`, [HASH, TX, ADDRESS]);
    await db.query(`INSERT INTO robinhood_chain_events (
      block_hash, block_number, transaction_hash, transaction_index, log_index,
      address, topic0, topics, data
    ) VALUES ($1, 123456, $2, 0, 1, $3, $4, $5::jsonb, '0x')`,
    [HASH, TX, ADDRESS, TOPIC, JSON.stringify([TOPIC])]);
    await db.query(`INSERT INTO robinhood_chain_v3_balance_snapshots (
      block_hash, log_index, pool_address, token_address, quote_address,
      token_balance_raw, quote_balance_raw
    ) VALUES ($1, 1, $2, $3, $4, 1, 2)`, [HASH, ADDRESS, TOKEN, QUOTE]);
    const cursor = backfill.encodeCursor({ chain: 'robinhood',
      block_hash: `0x${'f'.repeat(63)}d`, log_index: 0 });
    const args = { database: db, closePool: false, batchSize: 10, cursor };
    const preview = await backfill.run(args);
    assert.equal(preview.remainingInPage, 1);
    assert.equal((await backfill.run({ ...args, apply: true })).filled, 1);
    const { rows } = await db.query(`SELECT block_number FROM
      robinhood_chain_v3_balance_snapshots WHERE block_hash=$1`, [HASH]);
    assert.equal(rows[0].block_number, '123456');
    await db.query(`UPDATE robinhood_chain_v3_balance_snapshots
      SET block_number=123457 WHERE block_hash=$1`, [HASH]);
    await assert.rejects(backfill.run(args), /snapshot\/event mismatch/);
  } finally {
    await db.query('DELETE FROM robinhood_chain_blocks WHERE block_hash=$1', [HASH]);
  }
});

it('copies one finalized page without advancing capture and rejects changed payload on retry', async () => {
  const blockHash = `0x${'8'.repeat(64)}`;
  const transactionHash = `0x${'9'.repeat(64)}`;
  await db.query(`INSERT INTO robinhood_chain_blocks (
      block_number, block_hash, parent_hash, capture_digest, block_timestamp,
      head_observed_at, receipts_available_at
    ) VALUES (123457, $1, $2, $3, NOW(), NOW(), NOW())`,
  [blockHash, PARENT, transactionHash]);
  try {
    await db.query(`INSERT INTO robinhood_chain_transactions (
        block_hash, transaction_hash, transaction_index, from_address, receipt_succeeded
      ) VALUES ($1, $2, 0, $3, TRUE)`, [blockHash, transactionHash, ADDRESS]);
    await db.query(`INSERT INTO robinhood_chain_events (
        block_hash, block_number, transaction_hash, transaction_index, log_index,
        address, topic0, topics, data
      ) VALUES ($1, 123457, $2, 0, 1, $3, $4, $5::jsonb, '0x')`,
    [blockHash, transactionHash, ADDRESS, TOPIC, JSON.stringify([TOPIC])]);
    await db.query(`INSERT INTO robinhood_chain_capture_cursor (
        next_block, checkpoint_block, checkpoint_hash, node_head, finalized_head,
        recovery_state
      ) VALUES (123459, 123458, $1, 123458, 123458, 'running')`, [PARENT]);
    const options = { database: db, fromBlock: 123457, throughBlock: 123467,
      maxBlocks: 2 };
    const preview = await shadowCopy.copyPage(options);
    assert.equal(preview.mode, 'read-only');
    assert.equal(preview.events, '1');
    assert.equal(preview.nextBlock, 123459);
    assert.equal((await db.query(`SELECT count(*)::int AS n
      FROM robinhood_chain_events_shadow WHERE block_hash=$1`, [blockHash])).rows[0].n, 0);
    const applied = await shadowCopy.copyPage({ ...options, apply: true });
    assert.equal(applied.inserted, 1);
    assert.equal((await db.query(`SELECT next_block FROM robinhood_chain_capture_cursor
      WHERE chain='robinhood'`)).rows[0].next_block, '123459');
    assert.equal((await shadowCopy.copyPage({ ...options, apply: true })).inserted, 0);
    await db.query(`UPDATE robinhood_chain_events_shadow SET data='0xdead'
      WHERE block_hash=$1`, [blockHash]);
    await assert.rejects(shadowCopy.copyPage({ ...options, apply: true }),
      (error) => error.code === 'capture_shadow_mismatch');
    await assert.rejects(shadowCopy.copyPage({ ...options, fromBlock: 123459 }),
      /above finalized head/);
    assert.throws(() => shadowCopy.parseArgs([
      '--from-block=1', '--through-block=2', '--max-blocks=1001',
    ]), /maxBlocks/);
    assert.throws(() => shadowCopy.assertBoundedSource({ events: '5001',
      source_bytes: '0' }), /exceeds/);
    assert.throws(() => shadowCopy.assertBoundedSource({ events: '1',
      source_bytes: String(shadowCopy.MAX_SOURCE_BYTES + 1) }), /exceeds/);
  } finally {
    await db.query('DELETE FROM robinhood_chain_capture_cursor WHERE chain=$1', ['robinhood']);
    await db.query('DELETE FROM robinhood_chain_blocks WHERE block_hash=$1', [blockHash]);
  }
});
