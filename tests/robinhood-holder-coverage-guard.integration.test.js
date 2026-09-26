'use strict';

const assert = require('node:assert/strict');
const { after, it } = require('node:test');
const db = require('../src/models/db');
const stage231 = require('../src/utils/db-init-stage231');
const stage232 = require('../src/utils/db-init-stage232');
const stage233 = require('../src/utils/db-init-stage233');
const stage234 = require('../src/utils/db-init-stage234');
const { inspectRuntimeSchema } = require('../src/utils/runtime-schema');

const LEGACY = `0x${'c'.repeat(40)}`;
const TAIL = `0x${'b'.repeat(40)}`;
const REJECTED = `0x${'a'.repeat(40)}`;
const GLOBAL = `0x${'d'.repeat(40)}`;
const UNCOVERED = `0x${'e'.repeat(40)}`;
const HASH = `0x${'9'.repeat(64)}`;
const TOKENS = [LEGACY, TAIL, REJECTED];

after(() => db.pool.end());

async function rejectedStatement(client, sql, params, pattern) {
  await client.query('SAVEPOINT expected_rejection');
  await assert.rejects(client.query(sql, params), pattern);
  await client.query('ROLLBACK TO SAVEPOINT expected_rejection');
}

it('serializes tracked admissions and rejects states without current coverage', async () => {
  await stage231.init({ database: db, closePool: false });
  await stage232.init({ database: db, closePool: false });
  await stage233.init({ database: db, closePool: false });
  await stage234.init({ database: db, closePool: false });
  await stage234.init({ database: db, closePool: false });
  const { report } = await inspectRuntimeSchema();
  assert.equal(report.issues.some(({ key }) => (
    key === 'stage234-robinhood-holder-coverage-guard'
  )), false);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM robinhood_holder_legacy_coverage_manifest
      WHERE chain='robinhood' AND token_address=ANY($1::varchar[])`, [TOKENS]);
    await client.query(`DELETE FROM robinhood_holder_token_states
      WHERE chain='robinhood' AND token_address=ANY($1::varchar[])`, [TOKENS]);
    await client.query(`UPDATE robinhood_holder_capture_policy SET
      capture_mode='legacy', coverage_generation=0, cutover_next_block=NULL,
      cutover_checkpoint_block=NULL, cutover_checkpoint_hash=NULL
      WHERE chain='robinhood'`);
    await client.query(`INSERT INTO robinhood_holder_cursors (
      chain,stream,next_block,safe_head,checkpoint_block,checkpoint_hash,
      journal_floor_block,buffer_floor_block
    ) VALUES ('robinhood','live',200,199,199,$1,90,90)
    ON CONFLICT (chain,stream) DO UPDATE SET next_block=200,safe_head=199,
      checkpoint_block=199,checkpoint_hash=$1,journal_floor_block=90,buffer_floor_block=90`,
    [HASH]);
    await client.query(`INSERT INTO robinhood_holder_token_states (
      chain,token_address,holder_count,ledger_status,deployment_block,
      backfill_next_block,live_through_block,live_through_hash
    ) VALUES ('robinhood',$1,0,'shadow',100,101,100,$2)`, [LEGACY, HASH]);
    await client.query(`INSERT INTO robinhood_holder_legacy_coverage_manifest (
      chain,token_address,coverage_generation,baseline_status,
      baseline_deployment_block,baseline_backfill_next_block,
      baseline_live_through_block,baseline_live_through_hash,baseline_holder_count
    ) VALUES ('robinhood',$1,0,'shadow',100,101,100,$2,0)`, [LEGACY, HASH]);
    const cursor = (await client.query(`SELECT next_block FROM robinhood_holder_cursors
      WHERE chain='robinhood' AND stream='live' FOR UPDATE`)).rows[0];
    assert.ok(cursor && BigInt(cursor.next_block) > 0n);
    await client.query(`UPDATE robinhood_holder_capture_policy SET
      capture_mode='tracked', coverage_generation=1, cutover_next_block=101,
      cutover_checkpoint_block=100, cutover_checkpoint_hash=$1
      WHERE chain='robinhood'`, [HASH]);

    assert.equal((await client.query(`UPDATE robinhood_holder_token_states
      SET ledger_status='live' WHERE token_address=$1 RETURNING token_address`, [LEGACY])).rowCount, 1);
    await rejectedStatement(client, `UPDATE robinhood_holder_token_states
      SET backfill_next_block=backfill_next_block+1 WHERE token_address=$1`,
    [LEGACY], /no current coverage contract/);
    await client.query(`UPDATE robinhood_holder_token_states SET ledger_status='drifted'
      WHERE token_address=$1`, [LEGACY]);
    await rejectedStatement(client, `UPDATE robinhood_holder_token_states
      SET ledger_status='backfilling' WHERE token_address=$1`,
    [LEGACY], /no current coverage contract/);

    await rejectedStatement(client, `INSERT INTO robinhood_holder_token_states (
      chain,token_address,holder_count,ledger_status,deployment_block,backfill_next_block
    ) VALUES ('robinhood',$1,0,'backfilling',0,0)`,
    [REJECTED], /no current coverage contract/);
    await rejectedStatement(client, `INSERT INTO robinhood_holder_token_states (
      chain,token_address,holder_count,ledger_status,deployment_block,
      backfill_next_block,tail_capture_from_block
    ) VALUES ('robinhood',$1,0,'backfilling',0,0,$2)`,
    [REJECTED, (BigInt(cursor.next_block) - 1n).toString()], /behind the locked live cursor/);
    assert.equal((await client.query(`INSERT INTO robinhood_holder_token_states (
      chain,token_address,holder_count,ledger_status,deployment_block,
      backfill_next_block,tail_capture_from_block
    ) VALUES ('robinhood',$1,0,'backfilling',0,0,$2) RETURNING token_address`,
    [TAIL, cursor.next_block])).rowCount, 1);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

it('admits an attached global cohort at the covered barrier after live advances', async () => {
  await stage234.init({ database: db, closePool: false });
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    for (const table of [
      'robinhood_holder_token_states', 'robinhood_holder_cursors',
      'robinhood_holder_capture_policy', 'robinhood_holder_legacy_coverage_manifest',
      'robinhood_holder_global_backfill_runs', 'robinhood_holder_global_backfill_tokens',
    ]) {
      await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    await client.query(stage234.STATEMENTS[2]);
    await client.query(`INSERT INTO robinhood_holder_capture_policy (
      chain, capture_mode, coverage_generation, cutover_next_block,
      cutover_checkpoint_block, cutover_checkpoint_hash
    ) VALUES ('robinhood', 'tracked', 1, 100, 99, $1)`, [HASH]);
    await client.query(`INSERT INTO robinhood_holder_cursors (
      chain, stream, next_block, safe_head, checkpoint_block, checkpoint_hash,
      journal_floor_block, buffer_floor_block
    ) VALUES ('robinhood', 'live', 210, 209, 209, $1, 90, 90)`, [HASH]);
    await client.query(`INSERT INTO robinhood_holder_global_backfill_runs (
      id, chain, status, catalog_cutoff, next_block, checkpoint_block, checkpoint_hash,
      barrier_block, barrier_checkpoint_block, barrier_checkpoint_hash,
      barrier_attached_at, cohort_token_count
    ) VALUES (987654321, 'robinhood', 'attached', NOW(), 200, 199, $1,
      200, 199, $1, NOW(), 2)`, [HASH]);
    await client.query(`INSERT INTO robinhood_holder_global_backfill_tokens (
      run_id, chain, token_address, holder_count
    ) VALUES (987654321, 'robinhood', $1, 0),
             (987654321, 'robinhood', $2, 0)`, [GLOBAL, UNCOVERED]);
    const insert = `INSERT INTO robinhood_holder_token_states (
      chain, token_address, holder_count, ledger_status, deployment_block,
      backfill_next_block, live_through_block, live_through_hash,
      tail_capture_from_block
    ) VALUES ('robinhood', $1, 0, 'backfilling', 0, 200, 199, $2, 200)`;
    assert.equal((await client.query(insert, [GLOBAL, HASH])).rowCount, 1);
    await rejectedStatement(client, insert, [REJECTED, HASH],
      /behind the locked live cursor/);
    await client.query(`UPDATE robinhood_holder_cursors
      SET journal_floor_block = 201 WHERE chain = 'robinhood' AND stream = 'live'`);
    await rejectedStatement(client, insert, [UNCOVERED, HASH],
      /behind the locked live cursor/);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
