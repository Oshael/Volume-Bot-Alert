'use strict';

const assert = require('node:assert/strict');
const { after, test } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const {
  assertCutoverLayout, repairPage,
} = require('../src/utils/repair-robinhood-chain-event-cutover');

after(async () => { await db.pool.end(); });

test('repairs missing retired events idempotently and rolls back payload conflicts', async () => {
  await assertUsingTestDatabase(db);
  const client = await db.getClient();
  const relations = { source: 'pg_temp.rh_repair_retired',
    target: 'pg_temp.rh_repair_active' };
  try {
    await client.query(`CREATE TEMP TABLE rh_repair_retired (
      chain text NOT NULL, block_hash text NOT NULL, block_number bigint NOT NULL,
      transaction_hash text NOT NULL, transaction_index integer NOT NULL,
      log_index integer NOT NULL, address text NOT NULL, topic0 text NOT NULL,
      topics jsonb NOT NULL, data text NOT NULL, captured_at timestamptz NOT NULL
    )`);
    await client.query(`CREATE TEMP TABLE rh_repair_active (
      LIKE rh_repair_retired INCLUDING DEFAULTS,
      PRIMARY KEY (chain, block_number, block_hash, log_index)
    ) PARTITION BY RANGE (block_number)`);
    await client.query(`CREATE TEMP TABLE rh_repair_active_p0 PARTITION OF rh_repair_active
      FOR VALUES FROM (0) TO (1000)`);
    await client.query(`INSERT INTO rh_repair_retired
      SELECT 'robinhood', '0xblock', 123, '0xtx', 0, log_index,
        '0xaddress', '0xtopic', '["0xtopic"]'::jsonb, '0xdata', NOW()
      FROM generate_series(1, 2) AS log_index`);
    await client.query(`INSERT INTO rh_repair_active
      SELECT * FROM rh_repair_retired WHERE log_index=1`);
    const deps = { client, relations, assertFinalizedPage: async () => {} };
    const input = { fromBlock: 120, throughBlock: 129, maxBlocks: 10 };
    assert.equal((await repairPage(input, deps)).mismatch, 'count');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM rh_repair_active'))
      .rows[0].n, 1);
    assert.equal((await repairPage({ ...input, apply: true }, deps)).inserted, 1);
    assert.equal((await repairPage({ ...input, apply: true }, deps)).inserted, 0);
    await client.query(`UPDATE rh_repair_active SET data='0xdead' WHERE log_index=1`);
    await client.query(`INSERT INTO rh_repair_retired
      SELECT chain, block_hash, block_number, transaction_hash,
        transaction_index, 3, address, topic0, topics, data, captured_at
      FROM rh_repair_retired WHERE log_index=1`);
    await assert.rejects(repairPage({ ...input, apply: true }, deps),
      /retired\/active event mismatch/);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM rh_repair_active'))
      .rows[0].n, 2);
    await client.query(`UPDATE rh_repair_active SET data='0xdata' WHERE log_index=1`);
    assert.equal((await repairPage({ ...input, apply: true }, deps)).inserted, 1);
    await client.query(`INSERT INTO rh_repair_active
      SELECT chain, block_hash, block_number, transaction_hash,
        transaction_index, 4, address, topic0, topics, data, captured_at
      FROM rh_repair_retired WHERE log_index=1`);
    await assert.rejects(repairPage({ ...input, apply: true }, deps),
      /retired\/active event mismatch/);
    await assert.rejects(assertCutoverLayout(client,
      relations.target, relations.source), /retired source/);
  } finally {
    await client.query('DROP TABLE IF EXISTS rh_repair_active');
    await client.query('DROP TABLE IF EXISTS rh_repair_retired');
    client.release();
  }
});
