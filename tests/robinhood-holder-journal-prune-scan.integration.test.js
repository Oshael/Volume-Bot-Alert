'use strict';

const assert = require('node:assert/strict');
const { after, it } = require('node:test');
const db = require('../src/models/db');
const stage229 = require('../src/utils/db-init-stage229');
const { SCHEMA_GROUPS, inspectRuntimeSchema } = require('../src/utils/runtime-schema');

after(() => db.pool.end());

it('installs an idempotent, durable holder prune scan cursor with ordered-key invariants', async () => {
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage229-robinhood-holder-journal-prune-scan'
  ));
  assert.equal(group.repair, 'node src/utils/db-init-stage229.js');
  assert.equal(group.tables[0].table, stage229.TABLE_NAME);

  await stage229.init({ database: db, closePool: false });
  await stage229.init({ database: db, closePool: false });
  const { report } = await inspectRuntimeSchema();
  assert.equal(report.issues.some(({ key }) => key === group.key), false);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const initial = await client.query(
      `SELECT scan_cutoff_block, cursor_block_number, completed_passes
         FROM ${stage229.TABLE_NAME} WHERE chain = 'robinhood' FOR UPDATE`
    );
    assert.equal(initial.rowCount, 1);
    assert.ok(BigInt(initial.rows[0].completed_passes) >= 0n);

    await client.query(
      `UPDATE ${stage229.TABLE_NAME}
          SET scan_cutoff_block = 100, cursor_block_number = 99,
              cursor_transaction_index = 1, cursor_log_index = 2,
              cursor_transaction_hash = $1
        WHERE chain = 'robinhood'`,
      [`0x${'a'.repeat(64)}`]
    );
    await client.query('SAVEPOINT invalid_cursor');
    await assert.rejects(
      client.query(
        `UPDATE ${stage229.TABLE_NAME}
            SET cursor_log_index = NULL WHERE chain = 'robinhood'`
      ), /rh_holder_journal_prune_scans_cursor_check/
    );
    await client.query('ROLLBACK TO SAVEPOINT invalid_cursor');
    await assert.rejects(
      client.query(
        `UPDATE ${stage229.TABLE_NAME}
            SET scan_cutoff_block = 99 WHERE chain = 'robinhood'`
      ), /rh_holder_journal_prune_scans_cursor_check/
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
