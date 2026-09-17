'use strict';

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const db = require('../src/models/db');
const stage236 = require('../src/utils/db-init-stage236');
const stage237 = require('../src/utils/db-init-stage237');
const { runBatch } = require('../src/utils/backfill-robinhood-wallet-swap-realtime-states');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TX = `0x${'f'.repeat(63)}e`;
const PREVIOUS_TX = `0x${'f'.repeat(63)}d`;
const BLOCK = `0x${'c'.repeat(64)}`;
const LOG_INDEX = '987654322';

async function cleanup() {
  await db.query(`DELETE FROM ${stage236.SOURCE_TABLE}
    WHERE transaction_hash=$1 AND log_index=$2`, [TX, LOG_INDEX]);
  await db.query(`UPDATE ${stage237.PROGRESS_TABLE} SET
    after_transaction_hash=NULL, after_log_index=NULL, after_block_hash=NULL,
    after_event_kind=NULL, scanned=0, inserted=0, completed_at=NULL, updated_at=NOW()
    WHERE chain='robinhood'`);
}

before(async () => {
  await assertUsingTestDatabase(db);
  await stage236.init({ database: db, closePool: false });
  await stage237.init({ database: db, closePool: false });
  await stage237.init({ database: db, closePool: false });
  await cleanup();
});

after(async () => {
  await cleanup();
  await db.pool.end();
});

test('backfill resumes by key, repairs missing shadow state and proves batch parity', async () => {
  await db.query(
    `INSERT INTO ${stage236.SOURCE_TABLE} (
       transaction_hash, log_index, event_kind, block_number,
       block_hash, transaction_index, payload
     ) VALUES ($1,$2,'observed',124,$3,5,'{}'::jsonb)`,
    [TX, LOG_INDEX, BLOCK]
  );
  await db.query(`DELETE FROM ${stage236.STATE_TABLE}
    WHERE transaction_hash=$1 AND log_index=$2`, [TX, LOG_INDEX]);
  await db.query(`UPDATE ${stage237.PROGRESS_TABLE} SET
    after_transaction_hash=$2, after_log_index=0, after_block_hash=$3,
    after_event_kind='observed', scanned=0, inserted=0,
    completed_at=NULL, updated_at=NOW() WHERE chain=$1`,
  ['robinhood', PREVIOUS_TX, BLOCK]);

  const preview = await runBatch({ apply: false, limit: 100 }, { database: db });
  assert.equal(preview.mode, 'preview');
  assert.ok(preview.missing >= 1);

  const applied = await runBatch({ apply: true, limit: 100 }, { database: db });
  assert.equal(applied.mode, 'apply');
  assert.equal(applied.missing, 0);
  assert.equal(applied.divergent, 0);
  assert.ok(applied.inserted >= 1);
  const state = await db.query(`SELECT block_number::text, status, audit_status
    FROM ${stage236.STATE_TABLE} WHERE transaction_hash=$1 AND log_index=$2`, [TX, LOG_INDEX]);
  assert.deepEqual(state.rows, [{
    block_number: '124', status: 'pending', audit_status: 'pending',
  }]);
});
