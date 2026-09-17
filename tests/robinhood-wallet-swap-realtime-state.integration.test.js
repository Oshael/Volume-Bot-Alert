'use strict';

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, test } = require('node:test');
const db = require('../src/models/db');
const stage236 = require('../src/utils/db-init-stage236');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TX = `0x${'a'.repeat(64)}`;
const BLOCK = `0x${'b'.repeat(64)}`;

after(() => db.pool.end());

test('Stage 236 mirrors lifecycle inserts, state transitions and deletion atomically', async () => {
  await assertUsingTestDatabase(db);
  await stage236.init({ database: db, closePool: false });
  await stage236.init({ database: db, closePool: false });
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO ${stage236.SOURCE_TABLE} (
         transaction_hash, log_index, event_kind, block_number,
         block_hash, transaction_index, payload
       ) VALUES ($1,987654321,'observed',123,$2,4,'{}'::jsonb)`,
      [TX, BLOCK]
    );
    let state = await client.query(
      `SELECT status, audit_status, attempt_count, audit_attempt_count
         FROM ${stage236.STATE_TABLE}
        WHERE transaction_hash=$1 AND log_index=987654321`,
      [TX]
    );
    assert.deepEqual(state.rows, [{
      status: 'pending', audit_status: 'pending',
      attempt_count: 0, audit_attempt_count: 0,
    }]);

    await client.query(
      `UPDATE ${stage236.SOURCE_TABLE}
          SET status='complete', published_at=NOW(), attempt_count=1,
              audit_status='complete', audited_at=NOW(), audit_attempt_count=1,
              terminalized_at=NOW(), updated_at=NOW()
        WHERE transaction_hash=$1 AND log_index=987654321`,
      [TX]
    );
    state = await client.query(
      `SELECT status, audit_status, attempt_count, audit_attempt_count,
              published_at IS NOT NULL AS published,
              audited_at IS NOT NULL AS audited,
              terminalized_at IS NOT NULL AS terminalized
         FROM ${stage236.STATE_TABLE}
        WHERE transaction_hash=$1 AND log_index=987654321`,
      [TX]
    );
    assert.deepEqual(state.rows, [{
      status: 'complete', audit_status: 'complete',
      attempt_count: 1, audit_attempt_count: 1,
      published: true, audited: true, terminalized: true,
    }]);

    await client.query(
      `DELETE FROM ${stage236.SOURCE_TABLE}
        WHERE transaction_hash=$1 AND log_index=987654321`,
      [TX]
    );
    state = await client.query(
      `SELECT 1 FROM ${stage236.STATE_TABLE}
        WHERE transaction_hash=$1 AND log_index=987654321`,
      [TX]
    );
    assert.equal(state.rowCount, 0);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
