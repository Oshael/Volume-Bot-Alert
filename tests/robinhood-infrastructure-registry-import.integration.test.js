process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  runRegistryImport,
} = require('../src/services/robinhood-infrastructure-registry-import');
const stage145 = require('../src/utils/db-init-stage145');
const stage146 = require('../src/utils/db-init-stage146');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const ADDRESS = `0x${'3'.repeat(40)}`;

function entry(overrides = {}) {
  return {
    address: ADDRESS, kind: 'cex', label: 'Audited Exchange', source: 'manual_audit',
    evidence: { reference: 'case-145' }, validFromBlock: '10', validThroughBlock: '20',
    verifiedAt: '2026-08-21T12:00:00Z', closure: {
      source: 'manual_audit', evidence: { reference: 'closure-146' },
      verifiedAt: '2026-08-21T13:00:00Z',
    }, ...overrides,
  };
}

async function cleanup() {
  await db.query('DELETE FROM robinhood_infrastructure_registry WHERE address = $1', [ADDRESS]);
}

describe('Robinhood infrastructure registry import integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage145.init({ closePool: false });
    await stage146.init({ closePool: false });
    await cleanup();
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('previews without writes, applies atomically and replays idempotently', async () => {
    const manifest = { entries: [entry()] };
    assert.deepEqual(await runRegistryImport({ manifest }, { database: db }), {
      mode: 'dry-run', entries: 1, insert: 1, unchanged: 0,
    });
    assert.equal((await db.query(
      'SELECT COUNT(*)::int AS count FROM robinhood_infrastructure_registry WHERE address = $1',
      [ADDRESS]
    )).rows[0].count, 0);

    assert.deepEqual(await runRegistryImport({ manifest, apply: true }, { database: db }), {
      mode: 'applied', entries: 1, inserted: 1, unchanged: 0,
    });
    assert.equal((await db.query(
      'SELECT closed_source FROM robinhood_infrastructure_registry WHERE address = $1',
      [ADDRESS]
    )).rows[0].closed_source, 'manual_audit');
    assert.deepEqual(await runRegistryImport({ manifest, apply: true }, { database: db }), {
      mode: 'applied', entries: 1, inserted: 0, unchanged: 1,
    });
    await assert.rejects(runRegistryImport({
      manifest: { entries: [entry({ validFromBlock: '20', validThroughBlock: '30' })] },
      apply: true,
    }, { database: db }), /Registry interval conflicts/);
    assert.equal((await db.query(
      'SELECT COUNT(*)::int AS count FROM robinhood_infrastructure_registry WHERE address = $1',
      [ADDRESS]
    )).rows[0].count, 1);
  });
});
