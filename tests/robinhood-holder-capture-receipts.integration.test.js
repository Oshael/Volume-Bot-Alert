'use strict';

const assert = require('node:assert/strict');
const { after, it } = require('node:test');
const db = require('../src/models/db');
const stage235 = require('../src/utils/db-init-stage235');
const { inspectRuntimeSchema } = require('../src/utils/runtime-schema');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const HASH = (digit) => `0x${digit.repeat(64)}`;
const ADDRESS = (digit) => `0x${digit.repeat(40)}`;

after(() => db.pool.end());

it('installs receipts idempotently and rejects journal evidence mutation', async () => {
  await assertUsingTestDatabase(db);
  await stage235.init({ database: db, closePool: false });
  await stage235.init({ database: db, closePool: false });
  const { report } = await inspectRuntimeSchema();
  assert.equal(report.issues.some(({ key }) => (
    key === 'stage235-robinhood-holder-capture-receipts'
  )), false);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO robinhood_holder_transfer_journal (
         block_number, block_hash, transaction_hash, transaction_index, log_index,
         token_address, from_wallet, to_wallet, amount_raw
       ) VALUES (1,$1,$2,0,991991,$3,$4,$5,1)`,
      [HASH('1'), HASH('2'), ADDRESS('3'), ADDRESS('4'), ADDRESS('5')]
    );
    await client.query('SAVEPOINT immutable_evidence');
    await assert.rejects(
      client.query(
        `UPDATE robinhood_holder_transfer_journal SET amount_raw=2
          WHERE chain='robinhood' AND transaction_hash=$1 AND log_index=991991`,
        [HASH('2')]
      ), /Robinhood holder journal evidence is immutable/
    );
    await client.query('ROLLBACK TO SAVEPOINT immutable_evidence');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
