process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const { createRobinhoodWalletPositionRepository } = require('../src/models/robinhood-wallet-position');
const stage126 = require('../src/utils/db-init-stage126');
const stage127 = require('../src/utils/db-init-stage127');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const VERSION = 'test_swap_only_v1';
const TOKEN = `0x${'11'.repeat(20)}`;
const WALLET = `0x${'22'.repeat(20)}`;

async function cleanup() {
  await db.query('DELETE FROM robinhood_wallet_token_positions WHERE projection_version = $1', [VERSION]);
  await db.query('DELETE FROM robinhood_wallet_position_cursors WHERE projection_version = $1', [VERSION]);
}

describe('Robinhood wallet position persistence', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage126.init({ closePool: false });
    await stage127.init({ closePool: false });
    await cleanup();
  });
  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('registers the versioned schema without destructive SQL', () => {
    const sql = stage126.STATEMENTS.join('\n');
    assert.match(sql, /PRIMARY KEY[\s\S]+projection_version/);
    assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX)/i);
    assert.equal(SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage126-robinhood-wallet-positions'
    )).repair, 'node src/utils/db-init-stage126.js');
  });

  it('commits positions with the cursor and rolls back a stale writer', async () => {
    const repository = createRobinhoodWalletPositionRepository({ database: db });
    const initial = await repository.initCursor({
      projectionVersion: VERSION, stream: 'seed', nextBlock: '100', safeHead: '200',
      nextBlockTime: '2026-08-01T00:00:00.000Z',
    });
    assert.equal(initial.version, 0);
    assert.equal(initial.nextBlockTime, '2026-08-01T00:00:00.000Z');

    const first = await repository.commitBatch({
      projectionVersion: VERSION, stream: 'seed', expectedVersion: 0,
      nextBlock: '101', safeHead: '200', checkpointBlock: '100',
      checkpointHash: `0x${'aa'.repeat(32)}`,
      positions: [{
        tokenAddress: TOKEN, walletAddress: WALLET, quantityRaw: '10',
        costBasisUsd: '25', buyVolumeUsd: '25', buyTxCount: 1,
        throughBlock: '100', throughLogIndex: '7',
      }],
    });
    assert.equal(first.committed, true);
    assert.equal(first.cursor.version, 1);

    const frontierOnly = await repository.commitBatch({
      projectionVersion: VERSION, stream: 'seed', expectedVersion: 1, nextBlock: '102',
    });
    assert.equal(frontierOnly.cursor.version, 2);
    assert.equal(frontierOnly.cursor.checkpointBlock, '100');

    const stale = await repository.commitBatch({
      projectionVersion: VERSION, stream: 'seed', expectedVersion: 1, nextBlock: '103',
      positions: [{
        tokenAddress: TOKEN, walletAddress: WALLET, quantityRaw: '99',
        costBasisUsd: '99', throughBlock: '102', throughLogIndex: '1',
      }],
    });
    assert.deepEqual(stale, { committed: false, reason: 'cursor_conflict' });

    const completed = await repository.commitBatch({
      projectionVersion: VERSION, stream: 'seed', expectedVersion: 2,
      nextBlock: '201', safeHead: '200', nextBlockTime: '2026-08-02T00:00:00.000Z',
    });
    assert.equal(completed.cursor.lifecycleState, 'complete');

    const { rows } = await db.query(
      `SELECT quantity_raw::text, cost_basis_usd::text
       FROM robinhood_wallet_token_positions
       WHERE projection_version = $1 AND token_address = $2 AND wallet_address = $3`,
      [VERSION, TOKEN, WALLET]
    );
    assert.deepEqual(rows[0], { quantity_raw: '10', cost_basis_usd: '25' });
  });
});
