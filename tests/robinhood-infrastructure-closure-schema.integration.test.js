process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage145 = require('../src/utils/db-init-stage145');
const stage146 = require('../src/utils/db-init-stage146');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const OPEN = `0x${'1'.repeat(40)}`;
const LEGACY = `0x${'2'.repeat(40)}`;

async function cleanup() {
  await db.query(
    'DELETE FROM robinhood_infrastructure_registry WHERE address = ANY($1)',
    [[OPEN, LEGACY]]
  );
}

async function insertEntry(address, throughBlock = null) {
  await db.query(
    `INSERT INTO robinhood_infrastructure_registry (
       address, kind, label, source, evidence_json, valid_from_block,
       valid_through_block, verified_at
     ) VALUES ($1, 'cex', 'Audited Exchange', 'integration_fixture',
       '{"reference":"closure-test"}', 10, $2, '2026-08-21T12:00:00Z')`,
    [address, throughBlock]
  );
}

describe('Robinhood infrastructure closure schema integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage145.init({ closePool: false });
    await stage146.init({ closePool: false });
    await stage146.init({ closePool: false });
    await cleanup();
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('accepts legacy closed rows and coherent audited closures', async () => {
    await insertEntry(LEGACY, 20);
    await insertEntry(OPEN);

    await assert.rejects(db.query(
      `UPDATE robinhood_infrastructure_registry
          SET valid_through_block = 20, closed_source = 'manual_audit'
        WHERE address = $1`, [OPEN]
    ), /rh_infrastructure_registry_closure_payload_check/);
    await assert.rejects(db.query(
      `UPDATE robinhood_infrastructure_registry
          SET closed_source = 'manual_audit', closed_evidence_json = '{"case":"close"}',
              closed_verified_at = '2026-08-21T13:00:00Z'
        WHERE address = $1`, [OPEN]
    ), /rh_infrastructure_registry_open_closure_check/);
    await db.query(
      `UPDATE robinhood_infrastructure_registry
          SET valid_through_block = 20, closed_source = 'manual_audit',
              closed_evidence_json = '{"case":"close"}',
              closed_verified_at = '2026-08-21T13:00:00Z'
        WHERE address = $1`, [OPEN]
    );
    const result = await db.query(
      `SELECT address, valid_through_block::text, closed_source,
              closed_evidence_json, closed_verified_at
         FROM robinhood_infrastructure_registry
        WHERE address = ANY($1) ORDER BY address`, [[OPEN, LEGACY]]
    );
    assert.equal(result.rows[0].closed_source, 'manual_audit');
    assert.deepEqual(result.rows[0].closed_evidence_json, { case: 'close' });
    assert.equal(result.rows[0].valid_through_block, '20');
    assert.equal(result.rows[1].closed_source, null);
  });
});
