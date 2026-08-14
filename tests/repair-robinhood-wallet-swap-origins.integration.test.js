process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const { repairOrigins } = require('../src/utils/repair-robinhood-wallet-swap-origins');
const stage63 = require('../src/utils/db-init-stage63');
const stage91 = require('../src/utils/db-init-stage91');
const stage122 = require('../src/utils/db-init-stage122');
const stage133 = require('../src/utils/db-init-stage133');
const { assertUsingTestDatabase } = require('./helpers/test-db');

async function cleanup() {
  await db.query(
    "DELETE FROM worker_leases WHERE lease_key = 'robinhood-wallet-swap-live-worker'"
  );
  await db.query(
    "DELETE FROM robinhood_wallet_swap_cursors WHERE chain = 'robinhood' AND stream IN ('seed', 'live')"
  );
}

async function origins() {
  const result = await db.query(
    `SELECT stream, origin_block::text FROM robinhood_wallet_swap_cursors
      WHERE chain = 'robinhood' ORDER BY stream`
  );
  return result.rows;
}

describe('Robinhood wallet-swap origin repair integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    for (const stage of [stage63, stage91, stage122, stage133]) {
      await stage.init({ closePool: false });
    }
    await cleanup();
  });
  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('repairs both origins atomically, idempotently and without changing progress', async () => {
    await db.query(
      `INSERT INTO robinhood_wallet_swap_cursors (
         chain, stream, next_block, safe_head, lifecycle_state, completed_at
       ) VALUES ('robinhood', 'seed', 201, 200, 'complete', NOW())`
    );
    await db.query(
      `INSERT INTO robinhood_wallet_swap_cursors (
         chain, stream, next_block, safe_head, lifecycle_state
       ) VALUES ('robinhood', 'live', 250, 249, 'running')`
    );

    const dryRun = await repairOrigins({ database: db, seedOriginBlock: '90' });
    assert.equal(dryRun.mode, 'dry-run');
    assert.equal(dryRun.pendingWrites, 2);
    assert.deepEqual(await origins(), [
      { stream: 'live', origin_block: null },
      { stream: 'seed', origin_block: null },
    ]);

    const confirmed = await repairOrigins({
      database: db, seedOriginBlock: '90', confirm: true,
    });
    assert.equal(confirmed.updated, 2);
    assert.equal(confirmed.pendingWrites, 0);
    assert.deepEqual(await origins(), [
      { stream: 'live', origin_block: '201' },
      { stream: 'seed', origin_block: '90' },
    ]);

    const repeated = await repairOrigins({
      database: db, seedOriginBlock: '90', confirm: true,
    });
    assert.equal(repeated.updated, 0);
    await assert.rejects(
      repairOrigins({ database: db, seedOriginBlock: '91', confirm: true }),
      /seed origin conflicts/
    );
  });
});
