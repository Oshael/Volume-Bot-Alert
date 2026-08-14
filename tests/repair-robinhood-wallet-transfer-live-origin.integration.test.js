process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const { repairLiveOrigin } = require('../src/utils/repair-robinhood-wallet-transfer-live-origin');
const stage50 = require('../src/utils/db-init-stage50');
const stage129 = require('../src/utils/db-init-stage129');
const stage134 = require('../src/utils/db-init-stage134');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const VERSION = 'test_transfer_origin_v1';

async function cleanup() {
  await db.query("DELETE FROM worker_leases WHERE lease_key = 'robinhood-wallet-transfer-live-worker'");
  await db.query('DELETE FROM robinhood_wallet_transfer_cursors WHERE projection_version = $1', [VERSION]);
}
async function origin() {
  const result = await db.query(
    'SELECT origin_block::text FROM robinhood_wallet_transfer_cursors WHERE projection_version = $1',
    [VERSION]
  );
  return result.rows[0]?.origin_block ?? null;
}

describe('Robinhood wallet-transfer LIVE origin repair integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    for (const stage of [stage50, stage129, stage134]) await stage.init({ closePool: false });
    await cleanup();
  });
  after(async () => { await cleanup(); await db.pool.end(); });

  it('repairs explicitly, atomically and idempotently', async () => {
    await db.query(
      `INSERT INTO robinhood_wallet_transfer_cursors (
         chain, projection_version, stream, next_block, next_block_time, lifecycle_state
       ) VALUES ('robinhood', $1, 'live', 250, NOW(), 'running')`,
      [VERSION]
    );
    const input = { database: db, projectionVersion: VERSION, liveOriginBlock: '90' };
    assert.equal((await repairLiveOrigin(input)).mode, 'dry-run');
    assert.equal(await origin(), null);
    assert.equal((await repairLiveOrigin({ ...input, confirm: true })).updated, 1);
    assert.equal(await origin(), '90');
    assert.equal((await repairLiveOrigin({ ...input, confirm: true })).updated, 0);
    await assert.rejects(
      repairLiveOrigin({ ...input, liveOriginBlock: '91', confirm: true }), /conflicts/
    );
  });
});
