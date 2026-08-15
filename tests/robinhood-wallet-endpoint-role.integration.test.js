process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage128 = require('../src/utils/db-init-stage128');
const stage135 = require('../src/utils/db-init-stage135');
const {
  createRobinhoodWalletEndpointRoleRepository,
} = require('../src/models/robinhood-wallet-endpoint-role');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const ADDRESS = `0x${'c'.repeat(40)}`;
const HASH = `0x${'d'.repeat(64)}`;
const TOKEN = `0x${'e'.repeat(40)}`;
const TX = `0x${'f'.repeat(64)}`;
const PARTITION = 'robinhood_token_transfer_events_2099_09_01';

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
    await stage128.init({ closePool: false });
    await stage135.init({ closePool: false });
    await db.query(`CREATE TABLE IF NOT EXISTS ${PARTITION}
      PARTITION OF robinhood_token_transfer_events
      FOR VALUES FROM ('2099-09-01T00:00:00.000Z') TO ('2099-09-02T00:00:00.000Z')`);
    await db.query('DELETE FROM robinhood_token_transfer_events WHERE token_address = $1', [TOKEN]);
    await db.query(
      'DELETE FROM robinhood_wallet_endpoint_roles WHERE endpoint_address = $1',
      [ADDRESS]
    );
  });

  after(async () => {
    await db.query('DELETE FROM robinhood_token_transfer_events WHERE token_address = $1', [TOKEN]);
    await db.query(
      'DELETE FROM robinhood_wallet_endpoint_roles WHERE endpoint_address = $1',
      [ADDRESS]
    );
    await db.query(`DROP TABLE IF EXISTS ${PARTITION}`);
    await db.pool.end();
  });

  it('keeps contract evidence while extending observed bounds', async () => {
    const repository = createRobinhoodWalletEndpointRoleRepository({ database: db });
    await db.query(
      `INSERT INTO robinhood_token_transfer_events (
         chain, block_number, block_hash, block_time, transaction_hash,
         transaction_index, log_index, token_address, from_wallet, to_wallet,
         amount_raw, transfer_kind, classification_version
       ) VALUES ('robinhood', 90, $1, '2099-09-01T00:00:00Z', $2,
         0, 0, $3, $4, '0x0000000000000000000000000000000000000000',
         1, 'unknown', 'rh_transfer_v1')`,
      [HASH, TX, TOKEN, ADDRESS]
    );
    assert.deepEqual(await repository.listUnresolvedCandidates(10), [{
      endpointAddress: ADDRESS, blockNumber: '90', blockHash: HASH,
    }]);
    await repository.upsertEvidence([evidence('wallet', '100')]);
    assert.equal((await repository.listUnresolvedCandidates(10))[0].blockNumber, '90');
    await repository.upsertEvidence([evidence('contract', '120')]);
    await repository.upsertEvidence([evidence('wallet', '140')]);

    const [stored] = await repository.loadRoles([ADDRESS]);
    assert.equal(stored.endpointRole, 'contract');
    assert.equal(stored.evidenceBlock, '120');
    assert.equal(stored.observedFromBlock, '100');
    assert.equal(stored.observedThroughBlock, '140');
    assert.equal((await repository.listUnresolvedCandidates(10))[0].blockNumber, '90');
    await repository.upsertEvidence([evidence('wallet', '90')]);
    const [expanded] = await repository.loadRoles([ADDRESS]);
    assert.equal(expanded.endpointRole, 'contract');
    assert.equal(expanded.observedFromBlock, '90');
    assert.equal(expanded.observedThroughBlock, '140');
    assert.deepEqual(await repository.listUnresolvedCandidates(10), []);
  });
});
