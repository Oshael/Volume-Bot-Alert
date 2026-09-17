'use strict';

const assert = require('node:assert/strict');
const { after, it } = require('node:test');
const db = require('../src/models/db');
const {
  createRobinhoodHolderRollbackPreflight,
} = require('../src/services/robinhood-holder-rollback-preflight');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;

after(() => db.pool.end());

it('reads real PostgreSQL cursor and canonical-retention evidence', async () => {
  await assertUsingTestDatabase(db);
  const client = await db.getClient();
  const database = {
    getClient: async () => ({ query: client.query.bind(client), release() {} }),
  };
  try {
    await client.query(`CREATE TEMP TABLE robinhood_holder_capture_policy (
      chain text, capture_mode text, version bigint, cutover_next_block bigint,
      cutover_checkpoint_block bigint, cutover_checkpoint_hash text
    )`);
    await client.query(`CREATE TEMP TABLE robinhood_holder_cursors (
      chain text, stream text, next_block bigint, checkpoint_block bigint,
      checkpoint_hash text
    )`);
    await client.query(`CREATE TEMP TABLE robinhood_chain_capture_cursor (
      chain text, checkpoint_block bigint
    )`);
    await client.query(`CREATE TEMP TABLE robinhood_chain_blocks (
      chain text, block_number bigint, block_hash text, canonical boolean
    )`);
    await client.query(`INSERT INTO robinhood_holder_capture_policy VALUES
      ('robinhood','tracked',4,101,100,$1)`, [HASH_A]);
    await client.query(`INSERT INTO robinhood_holder_cursors VALUES
      ('robinhood','live',151,150,$1)`, [HASH_B]);
    await client.query(`INSERT INTO robinhood_chain_capture_cursor VALUES
      ('robinhood',155)`);
    await client.query(`INSERT INTO robinhood_chain_blocks VALUES
      ('robinhood',90,$1,true), ('robinhood',100,$1,true),
      ('robinhood',150,$2,true)`, [HASH_A, HASH_B]);

    const audit = createRobinhoodHolderRollbackPreflight({ database });
    assert.equal((await audit.inspect()).readyForReconstruction, true);
    await client.query(`UPDATE robinhood_chain_blocks SET canonical=false
      WHERE block_number=100`);
    const changed = await audit.inspect();
    assert.equal(changed.readyForReconstruction, false);
    assert.ok(changed.blockers.includes('cutover_anchor_not_canonical'));
  } finally {
    for (const table of [
      'robinhood_chain_blocks', 'robinhood_chain_capture_cursor',
      'robinhood_holder_cursors', 'robinhood_holder_capture_policy',
    ]) await client.query(`DROP TABLE IF EXISTS pg_temp.${table}`);
    client.release();
  }
});
