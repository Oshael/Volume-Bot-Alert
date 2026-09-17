'use strict';

const assert = require('node:assert/strict');
const { after, it } = require('node:test');
const db = require('../src/models/db');
const stage232 = require('../src/utils/db-init-stage232');
const { inspectRuntimeSchema } = require('../src/utils/runtime-schema');

const TOKEN = `0x${'e'.repeat(40)}`;
const HASH = `0x${'f'.repeat(64)}`;

after(() => db.pool.end());

it('installs an idempotent empty manifest and invalidates stale generations', async () => {
  await stage232.init({ database: db, closePool: false });
  await stage232.init({ database: db, closePool: false });
  const { report } = await inspectRuntimeSchema();
  assert.equal(report.issues.some(({ key }) => (
    key === 'stage232-robinhood-holder-legacy-coverage'
  )), false);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const policy = await client.query(
      `SELECT capture_mode, coverage_generation, cutover_next_block
         FROM ${stage232.POLICY_TABLE} WHERE chain='robinhood' FOR UPDATE`
    );
    assert.deepEqual(policy.rows[0], {
      capture_mode: 'legacy', coverage_generation: '0', cutover_next_block: null,
    });
    await assert.rejects(client.query(
      `UPDATE ${stage232.POLICY_TABLE} SET capture_mode='tracked' WHERE chain='robinhood'`
    ), /rh_holder_capture_policy_cutover_check/);
    await client.query('ROLLBACK');
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO robinhood_holder_token_states (
         chain, token_address, holder_count, ledger_status, deployment_block,
         backfill_next_block, live_through_block, live_through_hash,
         coverage_generation
       ) VALUES ('robinhood',$1,0,'shadow',100,100,100,$2,1)`, [TOKEN, HASH]
    );
    await client.query(
      `INSERT INTO ${stage232.MANIFEST_TABLE} (
         chain, token_address, coverage_generation, baseline_status,
         baseline_deployment_block, baseline_backfill_next_block,
         baseline_live_through_block, baseline_live_through_hash,
         baseline_holder_count
       ) VALUES ('robinhood',$1,1,'shadow',100,100,100,$2,0)`, [TOKEN, HASH]
    );
    const promoted = await client.query(
      `UPDATE robinhood_holder_token_states SET ledger_status='live'
        WHERE chain='robinhood' AND token_address=$1 RETURNING coverage_generation`, [TOKEN]
    );
    assert.equal(promoted.rows[0].coverage_generation, '1');
    const invalidated = await client.query(
      `UPDATE robinhood_holder_token_states SET ledger_status='drifted'
        WHERE chain='robinhood' AND token_address=$1 RETURNING coverage_generation`, [TOKEN]
    );
    assert.equal(invalidated.rows[0].coverage_generation, '2');
    const stale = await client.query(
      `SELECT 1 FROM ${stage232.MANIFEST_TABLE} manifest
        JOIN robinhood_holder_token_states state USING (chain, token_address)
       WHERE manifest.token_address=$1
         AND manifest.coverage_generation <> state.coverage_generation`, [TOKEN]
    );
    assert.equal(stale.rowCount, 1);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
