process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage129 = require('../src/utils/db-init-stage129');
const stage130 = require('../src/utils/db-init-stage130');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'1'.repeat(40)}`;
const LEFT = `0x${'2'.repeat(40)}`;
const RIGHT = `0x${'3'.repeat(40)}`;
const TX = `0x${'a'.repeat(64)}`;
const TIME = '2099-01-01T00:00:00.000Z';
const VERSIONS = ['test_transfer_v1', 'test_transfer_v2'];

async function cleanup() {
  await db.query('DELETE FROM robinhood_wallet_relationship_evidence WHERE algorithm_version = ANY($1)', [VERSIONS]);
  await db.query('DELETE FROM robinhood_wallet_transfer_edges WHERE classification_version = ANY($1)', [VERSIONS]);
  await db.query('DELETE FROM robinhood_wallet_transfer_cursors WHERE projection_version = ANY($1)', [VERSIONS]);
}

async function insertEdge(version) {
  return db.query(
    `INSERT INTO robinhood_wallet_transfer_edges (
       chain, classification_version, token_address, from_wallet, to_wallet,
       transfer_count, total_amount_raw, first_block, first_seen_at,
       first_transaction_hash, last_block, last_seen_at, last_transaction_hash,
       largest_amount_raw, largest_transaction_hash, first_log_index,
       last_log_index, largest_log_index
     ) VALUES ('robinhood', $1, $2, $3, $4, 1, 0, 10, $5, $6, 10, $5, $6, 0, $6,
       1, 1, 1)`,
    [version, TOKEN, LEFT, RIGHT, TIME, TX]
  );
}

describe('Robinhood wallet transfer projection schema integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage129.init({ closePool: false });
    await stage130.init({ closePool: false });
    await cleanup();
  });
  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('coexists by version and bounds each relationship evidence role', async () => {
    await insertEdge(VERSIONS[0]);
    await insertEdge(VERSIONS[1]);
    const edges = await db.query(
      'SELECT classification_version FROM robinhood_wallet_transfer_edges WHERE token_address = $1 ORDER BY 1',
      [TOKEN]
    );
    assert.deepEqual(edges.rows.map((row) => row.classification_version), VERSIONS);

    const evidenceSql = `INSERT INTO robinhood_wallet_relationship_evidence (
      chain, token_address, left_wallet, right_wallet, relationship_kind,
      evidence_role, evidence_transaction_hash, evidence_block,
      evidence_log_index, evidence_at, amount_raw, score_component, algorithm_version
    ) VALUES ('robinhood', $1, $2, $3, 'direct_transfer', 'first', $4, 10, 1,
      $5, 0, 'direct_transfer', $6)`;
    await db.query(evidenceSql, [TOKEN, LEFT, RIGHT, TX, TIME, VERSIONS[0]]);
    await assert.rejects(
      db.query(evidenceSql, [TOKEN, LEFT, RIGHT, `0x${'b'.repeat(64)}`, TIME, VERSIONS[0]]),
      /idx_rh_wallet_relationship_evidence_slot/
    );

    for (const version of VERSIONS) {
      await db.query(
        `INSERT INTO robinhood_wallet_transfer_cursors (
           chain, projection_version, stream, next_block, next_block_time
         ) VALUES ('robinhood', $1, 'seed', 10, $2)`,
        [version, TIME]
      );
    }
    await assert.rejects(db.query(
      `UPDATE robinhood_wallet_transfer_cursors
       SET lifecycle_state = 'failed', state_reason = 'boom'
       WHERE projection_version = $1`,
      [VERSIONS[0]]
    ), /rh_wallet_transfer_cursors_state_check/);
  });
});
