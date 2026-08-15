process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage135 = require('../src/utils/db-init-stage135');
const {
  createRobinhoodWalletEndpointRoleRepository,
} = require('../src/models/robinhood-wallet-endpoint-role');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const ADDRESS = `0x${'c'.repeat(40)}`;
const HASH = `0x${'d'.repeat(64)}`;

function evidence(endpointRole, evidenceBlock) {
  return {
    endpointAddress: ADDRESS,
    endpointRole,
    evidenceSource: 'pc_archive',
    evidenceBlock,
    evidenceBlockHash: HASH,
    resolverVersion: 'rh_endpoint_v1',
  };
}

describe('Robinhood wallet endpoint role persistence', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage135.init({ closePool: false });
    await db.query(
      'DELETE FROM robinhood_wallet_endpoint_roles WHERE endpoint_address = $1',
      [ADDRESS]
    );
  });

  after(async () => {
    await db.query(
      'DELETE FROM robinhood_wallet_endpoint_roles WHERE endpoint_address = $1',
      [ADDRESS]
    );
    await db.pool.end();
  });

  it('keeps contract evidence while extending observed bounds', async () => {
    const repository = createRobinhoodWalletEndpointRoleRepository({ database: db });
    await repository.upsertEvidence([evidence('wallet', '100')]);
    await repository.upsertEvidence([evidence('contract', '120')]);
    await repository.upsertEvidence([evidence('wallet', '140')]);

    const [stored] = await repository.loadRoles([ADDRESS]);
    assert.equal(stored.endpointRole, 'contract');
    assert.equal(stored.evidenceBlock, '120');
    assert.equal(stored.observedFromBlock, '100');
    assert.equal(stored.observedThroughBlock, '140');
  });
});
