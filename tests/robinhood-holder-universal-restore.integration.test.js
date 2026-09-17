'use strict';

const assert = require('node:assert/strict');
const { after, it } = require('node:test');
const db = require('../src/models/db');
const { TRANSFER_TOPIC } = require('../src/services/evm-erc20-supply-delta');
const {
  createRobinhoodCanonicalHolderSource,
} = require('../src/models/robinhood-canonical-holder-source');
const {
  createRobinhoodHolderUniversalRestore,
} = require('../src/services/robinhood-holder-universal-restore');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;
const HASH_C = `0x${'c'.repeat(64)}`;
const TX = `0x${'d'.repeat(64)}`;
const TOKEN = `0x${'1'.repeat(40)}`;
const FROM = `0x${'2'.repeat(40)}`;
const TO = `0x${'3'.repeat(40)}`;
const topicAddress = (address) => `0x${'0'.repeat(24)}${address.slice(2)}`;

after(() => db.pool.end());

it('restores a bounded canonical range idempotently and rejects stale or divergent evidence', async () => {
  await assertUsingTestDatabase(db);
  const client = await db.getClient();
  const query = client.query.bind(client);
  const database = { query, getClient: async () => ({ query, release() {} }) };
  try {
    await query(`CREATE TEMP TABLE robinhood_holder_capture_policy (
      chain text, capture_mode text, version bigint, cutover_next_block bigint,
      cutover_checkpoint_block bigint, cutover_checkpoint_hash text
    )`);
    await query(`CREATE TEMP TABLE robinhood_holder_cursors (
      chain text, stream text, next_block bigint, version bigint,
      checkpoint_block bigint, checkpoint_hash text
    )`);
    await query(`CREATE TEMP TABLE robinhood_chain_capture_cursor (
      chain text, checkpoint_block bigint, node_head bigint
    )`);
    await query(`CREATE TEMP TABLE robinhood_chain_blocks (
      chain text, block_number bigint, block_hash text, canonical boolean
    )`);
    await query(`CREATE TEMP TABLE robinhood_chain_events (
      chain text, block_number bigint, block_hash text, transaction_hash text,
      transaction_index int, log_index int, address text, topic0 text,
      topics jsonb, data text
    )`);
    await query(`CREATE TEMP TABLE robinhood_holder_transfer_journal
      (LIKE public.robinhood_holder_transfer_journal INCLUDING ALL)`);
    await query(`INSERT INTO robinhood_holder_capture_policy VALUES
      ('robinhood','tracked',1,101,100,$1)`, [HASH_A]);
    await query(`INSERT INTO robinhood_holder_cursors VALUES
      ('robinhood','live',103,5,102,$1)`, [HASH_C]);
    await query(`INSERT INTO robinhood_chain_capture_cursor VALUES
      ('robinhood',103,110)`);
    await query(`INSERT INTO robinhood_chain_blocks VALUES
      ('robinhood',100,$1,true), ('robinhood',101,$2,true),
      ('robinhood',102,$3,true)`, [HASH_A, HASH_B, HASH_C]);
    await query(`INSERT INTO robinhood_chain_events VALUES
      ('robinhood',101,$1,$2,0,0,$3,$4,$5::jsonb,$6)`, [
      HASH_B, TX, TOKEN, TRANSFER_TOPIC,
      JSON.stringify([TRANSFER_TOPIC, topicAddress(FROM), topicAddress(TO)]),
      `0x${'0'.repeat(63)}5`,
    ]);

    const restore = createRobinhoodHolderUniversalRestore({ database });
    const input = { fromBlock: '101', toBlock: '102' };
    assert.equal((await restore.restoreRange(input)).observedTransfers, 1);
    assert.equal((await query('SELECT COUNT(*)::int AS total FROM robinhood_holder_transfer_journal'))
      .rows[0].total, 0);
    assert.deepEqual(await restore.restoreRange({ ...input, apply: true }), {
      mode: 'apply', fromBlock: '101', toBlock: '102', matched: 1,
      inserted: 1, alreadyPresent: 0,
    });
    assert.equal(String((await query('SELECT next_block FROM robinhood_holder_cursors'))
      .rows[0].next_block), '103');
    assert.equal((await restore.restoreRange({ ...input, apply: true })).alreadyPresent, 1);
    await query('UPDATE robinhood_holder_transfer_journal SET amount_raw=6');
    await assert.rejects(restore.restoreRange({ ...input, apply: true }), {
      code: 'holder_capture_conflict',
    });
    await query('UPDATE robinhood_holder_transfer_journal SET amount_raw=5');

    const canonical = createRobinhoodCanonicalHolderSource({ database });
    const racing = createRobinhoodHolderUniversalRestore({ database, source: {
      async readGlobalRange(range) {
        const captured = await canonical.readGlobalRange(range);
        await query('UPDATE robinhood_holder_capture_policy SET version=version+1');
        return captured;
      },
    } });
    await assert.rejects(racing.restoreRange({ ...input, apply: true }), {
      code: 'holder_universal_restore_unavailable', reason: 'cursor-or-policy-changed',
    });

    const changedRaw = createRobinhoodHolderUniversalRestore({ database, source: {
      async readGlobalRange(range) {
        const captured = await canonical.readGlobalRange(range);
        await query('UPDATE robinhood_chain_blocks SET canonical=false WHERE block_number=101');
        return captured;
      },
    } });
    await assert.rejects(changedRaw.restoreRange({ ...input, apply: true }), {
      code: 'holder_universal_restore_unavailable', reason: 'raw-range-incomplete-or-changed',
    });
    await query('UPDATE robinhood_chain_blocks SET canonical=true WHERE block_number=101');

    const source = createRobinhoodHolderUniversalRestore({ database });
    await query("UPDATE robinhood_holder_capture_policy SET capture_mode='legacy'");
    await assert.rejects(source.restoreRange(input), {
      code: 'holder_universal_restore_unavailable', reason: 'tracked-policy-required',
    });
    await query("UPDATE robinhood_holder_capture_policy SET capture_mode='tracked'");
    await query('UPDATE robinhood_chain_blocks SET canonical=false WHERE block_number=102');
    await assert.rejects(restore.restoreRange(input), {
      code: 'canonical_holder_source_gap',
    });
  } finally {
    for (const table of [
      'robinhood_holder_transfer_journal', 'robinhood_chain_events',
      'robinhood_chain_blocks', 'robinhood_chain_capture_cursor',
      'robinhood_holder_cursors', 'robinhood_holder_capture_policy',
    ]) await query(`DROP TABLE IF EXISTS pg_temp.${table}`);
    client.release();
  }
});
