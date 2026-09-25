'use strict';

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const db = require('../src/models/db');
const { RULE_VERSION } = require('../src/utils/db-init-stage188');
const stage241 = require('../src/utils/db-init-stage241');
const stage251 = require('../src/utils/db-init-stage251');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const BLOCK = 99_124_100;
const HASH = `0x${'a'.repeat(64)}`;
const OTHER_HASH = `0x${'b'.repeat(64)}`;
const PARENT_HASH = `0x${'c'.repeat(64)}`;
const DIGEST = `0x${'d'.repeat(64)}`;
const TOKEN = `0x${'e'.repeat(40)}`;
const NEXT_TOKEN = `0x${'f'.repeat(40)}`;

async function insertBlock(client, number, hash) {
  await client.query(`INSERT INTO robinhood_chain_blocks(
    chain, block_number, block_hash, parent_hash, capture_digest,
    block_timestamp, finality, canonical, head_observed_at, receipts_available_at
  ) VALUES ('robinhood', $1, $2, $3, $4, NOW(), 'finalized', TRUE, NOW(), NOW())`,
  [number, hash, PARENT_HASH, DIGEST]);
}

describe('Stage 241 wallet-classification anchors', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage241.init({ closePool: false });
    await stage241.init({ closePool: false });
  });
  after(async () => { await db.pool.end(); });

  it('captures activation and queue anchors independently from raw retention', async () => {
    const client = await db.getClient();
    await client.query('BEGIN');
    try {
      await client.query('DELETE FROM robinhood_bundle_redistribution_queue');
      await client.query('DELETE FROM robinhood_bundle_redistribution_activations');
      await insertBlock(client, BLOCK, HASH);
      await client.query(`INSERT INTO robinhood_bundle_redistribution_activations(
        chain, rule_version, status, activation_at, activation_block
      ) VALUES ('robinhood', $1, 'planned', NOW(), $2)`, [RULE_VERSION, BLOCK - 1]);
      await client.query(`UPDATE robinhood_bundle_redistribution_activations SET
        status='active', activation_checkpoint_block=$2,
        activation_checkpoint_hash=$3, activated_at=NOW()
        WHERE chain='robinhood' AND rule_version=$1`, [RULE_VERSION, BLOCK, HASH]);

      const activation = (await client.query(`SELECT observation_from_hash,
          observation_from_time IS NOT NULL AS has_time
        FROM robinhood_bundle_redistribution_activations
        WHERE chain='robinhood' AND rule_version=$1`, [RULE_VERSION])).rows[0];
      assert.deepEqual(activation, { observation_from_hash: HASH, has_time: true });

      await client.query(`INSERT INTO robinhood_bundle_redistribution_queue(
        chain, token_address, rule_version, evidence_version,
        observation_from_block, event_through_block
      ) VALUES ('robinhood', $1, $2, 'rh_token_redistribution_v1', $3, $3)`,
      [TOKEN, RULE_VERSION, BLOCK]);
      const queue = (await client.query(`SELECT observation_from_hash,
          observation_from_time IS NOT NULL AS has_time
        FROM robinhood_bundle_redistribution_queue WHERE token_address=$1`, [TOKEN])).rows[0];
      assert.deepEqual(queue, { observation_from_hash: HASH, has_time: true });

      await client.query('DELETE FROM robinhood_chain_blocks WHERE block_hash=$1', [HASH]);
      assert.equal((await client.query(`SELECT COUNT(*)::integer AS count
        FROM robinhood_chain_block_anchors WHERE block_hash=$1`, [HASH])).rows[0].count, 1);

      await insertBlock(client, BLOCK + 1, OTHER_HASH);
      await client.query(`INSERT INTO robinhood_holder_token_states(
        chain, token_address, holder_count, ledger_status,
        live_through_block, live_through_hash
      ) VALUES ('robinhood', $1, 0, 'pending', $2, $3)`,
      [TOKEN, BLOCK + 1, OTHER_HASH]);
      assert.equal((await client.query(`SELECT COUNT(*)::integer AS count
        FROM robinhood_chain_block_anchors
        WHERE block_number=$1 AND block_hash=$2`,
      [BLOCK + 1, OTHER_HASH])).rows[0].count, 1);

      await client.query('SAVEPOINT mismatch');
      await assert.rejects(client.query(
        `SELECT capture_robinhood_chain_block_anchor('robinhood', $1, $2)`,
        [BLOCK + 1, HASH]
      ), /block anchor hash mismatch/);
      await client.query('ROLLBACK TO SAVEPOINT mismatch');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rehydrates old queues and anchors new ones from a unique durable block', async () => {
    const client = await db.getClient();
    await client.query('BEGIN');
    try {
      await client.query('DELETE FROM robinhood_bundle_redistribution_queue');
      await client.query('DELETE FROM robinhood_bundle_redistribution_activations');
      await insertBlock(client, BLOCK + 1, OTHER_HASH);
      await client.query(`INSERT INTO robinhood_bundle_redistribution_activations(
        chain, rule_version, status, activation_at, activation_block
      ) VALUES ('robinhood', $1, 'planned', NOW(), $2)`, [RULE_VERSION, BLOCK - 1]);
      await client.query(`UPDATE robinhood_bundle_redistribution_activations SET
        status='active', activation_checkpoint_block=$2,
        activation_checkpoint_hash=$3, activated_at=NOW()
        WHERE chain='robinhood' AND rule_version=$1`,
      [RULE_VERSION, BLOCK + 1, OTHER_HASH]);
      await client.query(`INSERT INTO robinhood_bundle_redistribution_queue(
        chain, token_address, rule_version, evidence_version,
        observation_from_block, event_through_block,
        status, lease_owner, lease_until, last_error_code, last_error_message
      ) VALUES ('robinhood', $1, $2, 'rh_token_redistribution_v1', $3, $3,
        'leased', 'test-worker', NOW() + INTERVAL '20 minutes',
        'redistribution_anchor_missing', 'observation missing')`,
      [TOKEN, RULE_VERSION, BLOCK]);
      assert.equal((await client.query(`SELECT observation_from_hash FROM
        robinhood_bundle_redistribution_queue WHERE token_address=$1`,
      [TOKEN])).rows[0].observation_from_hash, null);

      await client.query(`INSERT INTO robinhood_chain_block_anchors(
        chain, block_number, block_hash, block_timestamp
      ) VALUES ('robinhood', $1, $2, NOW())`, [BLOCK, HASH]);
      for (const statement of stage251.STATEMENTS.slice(1)) await client.query(statement);
      const activation = (await client.query(`SELECT observation_from_hash,
        observation_from_time IS NOT NULL AS has_time
        FROM robinhood_bundle_redistribution_activations
        WHERE chain='robinhood' AND rule_version=$1`, [RULE_VERSION])).rows[0];
      assert.deepEqual(activation, { observation_from_hash: HASH, has_time: true });
      const queue = (await client.query(`SELECT observation_from_hash,
        observation_from_time IS NOT NULL AS has_time, status, lease_owner,
        lease_until > NOW() AS lease_active, last_error_code
        FROM robinhood_bundle_redistribution_queue WHERE token_address=$1`, [TOKEN])).rows[0];
      assert.deepEqual(queue, {
        observation_from_hash: HASH, has_time: true, status: 'leased',
        lease_owner: 'test-worker', lease_active: true,
        last_error_code: 'redistribution_anchor_missing',
      });

      await client.query(`INSERT INTO robinhood_bundle_redistribution_queue(
        chain, token_address, rule_version, evidence_version,
        observation_from_block, event_through_block
      ) VALUES ('robinhood', $1, $2, 'rh_token_redistribution_v1', $3, $3)`,
      [NEXT_TOKEN, RULE_VERSION, BLOCK]);
      assert.equal((await client.query(`SELECT observation_from_hash FROM
        robinhood_bundle_redistribution_queue WHERE token_address=$1`,
      [NEXT_TOKEN])).rows[0].observation_from_hash, HASH);

      await client.query('SAVEPOINT ambiguous');
      await client.query(`INSERT INTO robinhood_chain_block_anchors(
        chain, block_number, block_hash, block_timestamp
      ) VALUES ('robinhood', $1, $2, NOW())`, [BLOCK, PARENT_HASH]);
      await assert.rejects(client.query(`SELECT capture_robinhood_chain_block_anchor(
        'robinhood', $1)`, [BLOCK]), /block anchor ambiguous/);
      await client.query('ROLLBACK TO SAVEPOINT ambiguous');
      await client.query('SAVEPOINT mismatch');
      await assert.rejects(client.query(`SELECT capture_robinhood_chain_block_anchor(
        'robinhood', $1, $2)`, [BLOCK, OTHER_HASH]), /block anchor hash mismatch/);
      await client.query('ROLLBACK TO SAVEPOINT mismatch');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
