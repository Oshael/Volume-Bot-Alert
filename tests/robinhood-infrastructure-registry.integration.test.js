process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodInfrastructureRegistryRepository,
} = require('../src/models/robinhood-infrastructure-registry');
const stage145 = require('../src/utils/db-init-stage145');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const HISTORICAL_CEX = `0x${'6'.repeat(40)}`;
const OPEN_CEX = `0x${'7'.repeat(40)}`;
const ROUTER = `0x${'8'.repeat(40)}`;
const AMBIGUOUS_CEX = `0x${'9'.repeat(40)}`;
const ADDRESSES = [HISTORICAL_CEX, OPEN_CEX, ROUTER, AMBIGUOUS_CEX];

async function cleanup() {
  await db.query(
    'DELETE FROM robinhood_infrastructure_registry WHERE address = ANY($1)',
    [ADDRESSES]
  );
}

async function insertEntry({ address, kind, from, through = null }) {
  await db.query(
    `INSERT INTO robinhood_infrastructure_registry (
       chain, address, kind, label, source, evidence_json,
       valid_from_block, valid_through_block, verified_at
     ) VALUES ('robinhood', $1, $2, $3, 'integration_fixture',
       '{"caseId":"registry-integration"}'::jsonb, $4, $5,
       '2026-08-21T12:00:00Z')`,
    [address, kind, `${kind} fixture`, from, through]
  );
}

describe('Robinhood infrastructure registry lookup integration', () => {
  const repository = createRobinhoodInfrastructureRegistryRepository({ database: db });

  before(async () => {
    await assertUsingTestDatabase(db);
    await stage145.init({ closePool: false });
    await cleanup();
    await insertEntry({ address: HISTORICAL_CEX, kind: 'cex', from: 10, through: 20 });
    await insertEntry({ address: OPEN_CEX, kind: 'cex', from: 20 });
    await insertEntry({ address: ROUTER, kind: 'router', from: 1 });
    await insertEntry({ address: AMBIGUOUS_CEX, kind: 'cex', from: 5, through: 15 });
    await insertEntry({ address: AMBIGUOUS_CEX, kind: 'cex', from: 10, through: 20 });
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('respects inclusive block validity and kind filters', async () => {
    assert.deepEqual((await repository.listActiveAtBlock({
      addresses: [HISTORICAL_CEX, OPEN_CEX], kinds: ['cex'], blockNumber: 9,
    })).map(({ address }) => address), []);

    assert.deepEqual((await repository.listActiveAtBlock({
      addresses: [HISTORICAL_CEX, OPEN_CEX], kinds: ['cex'], blockNumber: 10,
    })).map(({ address }) => address), [HISTORICAL_CEX]);

    assert.deepEqual((await repository.listActiveAtBlock({
      addresses: [HISTORICAL_CEX, OPEN_CEX], kinds: ['cex'], blockNumber: 20,
    })).map(({ address }) => address), [HISTORICAL_CEX, OPEN_CEX]);

    assert.deepEqual((await repository.listActiveAtBlock({
      addresses: [HISTORICAL_CEX, OPEN_CEX], kinds: ['cex'], blockNumber: 21,
    })).map(({ address }) => address), [OPEN_CEX]);

    assert.deepEqual((await repository.listActiveAtBlock({
      addresses: ADDRESSES, kinds: ['router'], blockNumber: 21,
    })).map(({ address, kind }) => ({ address, kind })), [{ address: ROUTER, kind: 'router' }]);
  });

  it('fails closed when historical validity windows overlap', async () => {
    await assert.rejects(repository.listActiveAtBlock({
      addresses: [AMBIGUOUS_CEX], kinds: ['cex'], blockNumber: 12,
    }), /Ambiguous infrastructure registry entries/);
  });
});
