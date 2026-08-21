process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage145 = require('../src/utils/db-init-stage145');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const CEX = `0x${'4'.repeat(40)}`;
const ROUTER = `0x${'5'.repeat(40)}`;

async function cleanup() {
  await db.query(
    'DELETE FROM robinhood_infrastructure_registry WHERE address = ANY($1)',
    [[CEX, ROUTER]]
  );
}

function insertEntry(overrides = {}) {
  const entry = {
    address: CEX, kind: 'cex', label: 'Example Exchange', source: 'manual_audit',
    evidence: { reference: 'case-1' }, fromBlock: '10', throughBlock: null,
    ...overrides,
  };
  return db.query(
    `INSERT INTO robinhood_infrastructure_registry (
       chain, address, kind, label, source, evidence_json,
       valid_from_block, valid_through_block, verified_at
     ) VALUES ('robinhood', $1, $2, $3, $4, $5::jsonb, $6, $7,
       '2026-08-21T12:00:00Z')`,
    [
      entry.address, entry.kind, entry.label, entry.source,
      JSON.stringify(entry.evidence), entry.fromBlock, entry.throughBlock,
    ]
  );
}

describe('Robinhood infrastructure registry schema integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage145.init({ closePool: false });
    await stage145.init({ closePool: false });
    await cleanup();
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('stores open and historical infrastructure evidence', async () => {
    await insertEntry();
    await insertEntry({
      address: ROUTER, kind: 'router', label: 'Historical Router',
      fromBlock: '20', throughBlock: '50',
    });
    const result = await db.query(
      `SELECT address, kind, label, valid_from_block::text, valid_through_block::text
         FROM robinhood_infrastructure_registry
        WHERE address = ANY($1) ORDER BY address`,
      [[CEX, ROUTER]]
    );

    assert.deepEqual(result.rows, [{
      address: CEX, kind: 'cex', label: 'Example Exchange',
      valid_from_block: '10', valid_through_block: null,
    }, {
      address: ROUTER, kind: 'router', label: 'Historical Router',
      valid_from_block: '20', valid_through_block: '50',
    }]);
  });

  it('rejects ambiguous, invalid or unevidenced entries', async () => {
    await assert.rejects(
      insertEntry({ fromBlock: '11' }), /idx_rh_infrastructure_registry_open/
    );
    await assert.rejects(
      insertEntry({ address: ROUTER, fromBlock: '20', throughBlock: '19' }),
      /rh_infrastructure_registry_validity_check/
    );
    await assert.rejects(
      insertEntry({ address: ROUTER, fromBlock: '20', evidence: {} }),
      /rh_infrastructure_registry_evidence_check/
    );
    await assert.rejects(
      insertEntry({
        address: '0x0000000000000000000000000000000000000000',
        fromBlock: '20',
      }),
      /rh_infrastructure_registry_address_check/
    );
  });
});
