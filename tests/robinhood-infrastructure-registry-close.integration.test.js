process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  runRegistryClosure,
} = require('../src/services/robinhood-infrastructure-registry-close');
const stage145 = require('../src/utils/db-init-stage145');
const stage146 = require('../src/utils/db-init-stage146');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const ADDRESS = `0x${'4'.repeat(40)}`;

function request(validThroughBlock) {
  return {
    address: ADDRESS, kind: 'cex', validFromBlock: '10', validThroughBlock,
    closure: {
      source: 'manual_audit', evidence: { reference: 'closure-case' },
      verifiedAt: '2026-08-21T13:00:00Z',
    },
  };
}

async function cleanup() {
  await db.query('DELETE FROM robinhood_infrastructure_registry WHERE address = $1', [ADDRESS]);
}

describe('Robinhood infrastructure registry closure integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage145.init({ closePool: false });
    await stage146.init({ closePool: false });
    await cleanup();
    await db.query(
      `INSERT INTO robinhood_infrastructure_registry (
         address, kind, label, source, evidence_json, valid_from_block,
         valid_through_block, verified_at
       ) VALUES ($1, 'cex', 'Open Exchange', 'integration_fixture', '{"case":"open"}',
         10, NULL, '2026-08-21T12:00:00Z'),
        ($1, 'cex', 'Future History', 'integration_fixture', '{"case":"future"}',
         20, 30, '2026-08-21T12:00:00Z')`, [ADDRESS]
    );
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('previews, rejects inclusive overlap, closes atomically and replays', async () => {
    await assert.rejects(runRegistryClosure({ request: request('20') }, { database: db }),
      /would overlap/);
    assert.deepEqual(await runRegistryClosure({ request: request('19') }, { database: db }), {
      mode: 'dry-run', action: 'close',
    });
    assert.equal((await db.query(
      `SELECT valid_through_block FROM robinhood_infrastructure_registry
        WHERE address = $1 AND valid_from_block = 10`, [ADDRESS]
    )).rows[0].valid_through_block, null);
    assert.deepEqual(await runRegistryClosure({
      request: request('19'), apply: true,
    }, { database: db }), { mode: 'applied', action: 'closed' });
    assert.deepEqual(await runRegistryClosure({
      request: request('19'), apply: true,
    }, { database: db }), { mode: 'applied', action: 'unchanged' });
    const stored = (await db.query(
      `SELECT valid_through_block::text, closed_source, closed_evidence_json
         FROM robinhood_infrastructure_registry
        WHERE address = $1 AND valid_from_block = 10`, [ADDRESS]
    )).rows[0];
    assert.deepEqual(stored, {
      valid_through_block: '19', closed_source: 'manual_audit',
      closed_evidence_json: { reference: 'closure-case' },
    });
  });
});
