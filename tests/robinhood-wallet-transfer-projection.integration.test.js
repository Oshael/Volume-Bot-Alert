process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const { createRobinhoodWalletPositionRepository } = require('../src/models/robinhood-wallet-position');
const {
  createRobinhoodWalletTransferProjectionRepository,
  persistTransferProjection,
} = require('../src/models/robinhood-wallet-transfer-projection');
const stage126 = require('../src/utils/db-init-stage126');
const stage127 = require('../src/utils/db-init-stage127');
const stage129 = require('../src/utils/db-init-stage129');
const stage130 = require('../src/utils/db-init-stage130');
const stage131 = require('../src/utils/db-init-stage131');
const stage134 = require('../src/utils/db-init-stage134');
const stage137 = require('../src/utils/db-init-stage137');
const stage153 = require('../src/utils/db-init-stage153');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const VERSION = 'test_transfer_projection_v1';
const ATOMIC_VERSION = 'test_transfer_position_atomic_v1';
const POSITION_VERSION = 'test_unified_transfer_v1';
const TOKEN = `0x${'1'.repeat(40)}`;
const ALICE = `0x${'2'.repeat(40)}`;
const BOB = `0x${'3'.repeat(40)}`;
function event(block, logIndex, amountRaw, transferKind = 'wallet_transfer') {
  return {
    blockNumber: String(block), transactionIndex: String(logIndex), logIndex: String(logIndex),
    blockTime: `2099-01-${block === 100 ? '01' : '02'}T00:00:00.000Z`,
    transactionHash: `0x${String(logIndex).padStart(64, 'a')}`,
    tokenAddress: TOKEN, fromWallet: ALICE, toWallet: BOB, amountRaw: String(amountRaw),
    transferKind, classificationVersion: VERSION,
  };
}

async function cleanup() {
  const transferVersions = [VERSION, ATOMIC_VERSION];
  await db.query('DELETE FROM robinhood_wallet_relationship_evidence WHERE algorithm_version = ANY($1::varchar[])', [transferVersions]);
  await db.query('DELETE FROM robinhood_wallet_transfer_edges WHERE classification_version = ANY($1::varchar[])', [transferVersions]);
  await db.query('DELETE FROM robinhood_wallet_transfer_daily_summaries WHERE projection_version = ANY($1::varchar[])', [transferVersions]);
  await db.query('DELETE FROM robinhood_wallet_transfer_cursors WHERE projection_version = ANY($1::varchar[])', [transferVersions]);
  await db.query('DELETE FROM robinhood_wallet_token_positions WHERE projection_version = $1', [POSITION_VERSION]);
  await db.query('DELETE FROM robinhood_wallet_position_cursors WHERE projection_version = $1', [POSITION_VERSION]);
}

describe('Robinhood wallet transfer projection persistence', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage126.init({ closePool: false });
    await stage127.init({ closePool: false });
    await stage129.init({ closePool: false });
    await stage130.init({ closePool: false });
    await stage131.init({ closePool: false });
    await stage134.init({ closePool: false });
    await stage137.init({ closePool: false });
    await stage153.init({ closePool: false });
    await cleanup();
  });
  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('commits edges, bounded evidence and cursor atomically', async () => {
    const repository = createRobinhoodWalletTransferProjectionRepository({ database: db });
    const initialized = await repository.initCursor({
      projectionVersion: VERSION, stream: 'seed', nextBlock: '100',
      nextBlockTime: '2099-01-01T00:00:00.000Z', safeHead: '200',
    });
    assert.equal(initialized.originBlock, '100');
    const first = await repository.commitBatch({
      projectionVersion: VERSION, stream: 'seed', expectedVersion: 0,
      nextBlock: '101', nextBlockTime: '2099-01-02T00:00:00.000Z', safeHead: '200',
      checkpointBlock: '100', checkpointHash: `0x${'f'.repeat(64)}`,
      summarizedThroughDay: '2099-01-01',
      events: [event(100, 5, 10, 'dex_flow')],
    });
    assert.equal(first.committed, true);
    assert.equal(first.cursor.version, 1);
    assert.deepEqual(
      { edges: first.edgeGroups, daily: first.dailySummaryGroups, evidence: first.evidenceCandidates },
      { edges: 1, daily: 1, evidence: 0 }
    );
    const pendingDirectional = await db.query(
      `SELECT first_wallet_transfer_block, first_wallet_transfer_transaction_hash
         FROM robinhood_wallet_transfer_edges WHERE classification_version = $1`,
      [VERSION]
    );
    assert.deepEqual(pendingDirectional.rows[0], {
      first_wallet_transfer_block: null, first_wallet_transfer_transaction_hash: null,
    });

    const stale = await repository.commitBatch({
      projectionVersion: VERSION, stream: 'seed', expectedVersion: 0,
      nextBlock: '102', nextBlockTime: '2099-01-03T00:00:00.000Z', safeHead: '200',
      events: [event(101, 1, 40)],
    });
    assert.deepEqual(stale, { committed: false, reason: 'cursor_conflict' });

    const second = await repository.commitBatch({
      projectionVersion: VERSION, stream: 'seed', expectedVersion: 1,
      nextBlock: '102', nextBlockTime: '2099-01-03T00:00:00.000Z',
      checkpointBlock: '101', checkpointHash: `0x${'e'.repeat(64)}`,
      summarizedThroughDay: '2099-01-02',
      events: [event(101, 3, 30), event(101, 2, 20), event(101, 1, 40)],
    });
    assert.equal(second.cursor.version, 2);
    assert.equal(second.cursor.safeHead, '200');

    const edge = await db.query(
      `SELECT transfer_count::text, total_amount_raw::text,
              wallet_transfer_count::text, dex_flow_count::text,
              first_block::text, first_log_index, last_block::text, last_log_index,
              largest_amount_raw::text, largest_log_index,
              first_wallet_transfer_block::text, first_wallet_transfer_log_index,
              first_wallet_transfer_transaction_hash,
              first_wallet_transfer_amount_raw::text
       FROM robinhood_wallet_transfer_edges WHERE classification_version = $1`,
      [VERSION]
    );
    assert.deepEqual(edge.rows[0], {
      transfer_count: '4', total_amount_raw: '100', wallet_transfer_count: '3',
      dex_flow_count: '1', first_block: '100', first_log_index: 5,
      last_block: '101', last_log_index: 3, largest_amount_raw: '40', largest_log_index: 1,
      first_wallet_transfer_block: '101', first_wallet_transfer_log_index: 1,
      first_wallet_transfer_transaction_hash: `0x${'1'.padStart(64, 'a')}`,
      first_wallet_transfer_amount_raw: '40',
    });
    const daily = await db.query(
      `SELECT summary_day::text, transfer_count::text, total_amount_raw::text,
              wallet_transfer_count::text, wallet_transfer_amount_raw::text,
              dex_flow_count::text, dex_flow_amount_raw::text,
              through_block::text, through_transaction_index, through_log_index
       FROM robinhood_wallet_transfer_daily_summaries
       WHERE projection_version = $1 ORDER BY summary_day`,
      [VERSION]
    );
    assert.deepEqual(daily.rows, [
      {
        summary_day: '2099-01-01', transfer_count: '1', total_amount_raw: '10',
        wallet_transfer_count: '0', wallet_transfer_amount_raw: '0',
        dex_flow_count: '1', dex_flow_amount_raw: '10', through_block: '100',
        through_transaction_index: 5, through_log_index: 5,
      },
      {
        summary_day: '2099-01-02', transfer_count: '3', total_amount_raw: '90',
        wallet_transfer_count: '3', wallet_transfer_amount_raw: '90',
        dex_flow_count: '0', dex_flow_amount_raw: '0', through_block: '101',
        through_transaction_index: 3, through_log_index: 3,
      },
    ]);
    const evidence = await db.query(
      `SELECT evidence_role, evidence_block::text, evidence_log_index
       FROM robinhood_wallet_relationship_evidence
       WHERE algorithm_version = $1 ORDER BY evidence_role`,
      [VERSION]
    );
    assert.deepEqual(evidence.rows, [
      { evidence_role: 'first', evidence_block: '101', evidence_log_index: 1 },
      { evidence_role: 'largest', evidence_block: '101', evidence_log_index: 1 },
      { evidence_role: 'last', evidence_block: '101', evidence_log_index: 3 },
    ]);

    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await persistTransferProjection(client, VERSION, [event(100, 4, 5)]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    const reclassifiedEarlier = await db.query(
      `SELECT first_wallet_transfer_block::text AS block_number,
              first_wallet_transfer_log_index AS log_index,
              first_wallet_transfer_transaction_hash AS transaction_hash,
              first_wallet_transfer_amount_raw::text AS amount_raw
         FROM robinhood_wallet_transfer_edges WHERE classification_version = $1`,
      [VERSION]
    );
    assert.deepEqual(reclassifiedEarlier.rows[0], {
      block_number: '100', log_index: 4,
      transaction_hash: `0x${'4'.padStart(64, 'a')}`, amount_raw: '5',
    });
  });

  it('commits unified positions with transfers and rolls everything back on position conflict', async () => {
    const positions = createRobinhoodWalletPositionRepository({ database: db });
    const transfers = createRobinhoodWalletTransferProjectionRepository({
      database: db, positionProjection: positions,
    });
    await transfers.initCursor({
      projectionVersion: ATOMIC_VERSION, stream: 'seed', nextBlock: '100',
      nextBlockTime: '2099-01-01T00:00:00.000Z', safeHead: '200',
    });
    const positionInitialized = await positions.initCursor({
      projectionVersion: POSITION_VERSION, stream: 'seed', nextBlock: '100',
      nextBlockTime: '2099-01-01T00:00:00.000Z', safeHead: '200',
    });
    assert.equal(positionInitialized.originBlock, '100');
    const atomicEvent = { ...event(100, 5, 10), classificationVersion: ATOMIC_VERSION };
    const first = await transfers.commitBatch({
      projectionVersion: ATOMIC_VERSION, stream: 'seed', expectedVersion: 0,
      nextBlock: '101', nextBlockTime: '2099-01-02T00:00:00.000Z', safeHead: '200',
      events: [atomicEvent],
      positionBatch: {
        projectionVersion: POSITION_VERSION, stream: 'seed', expectedVersion: 0,
        nextBlock: '101', nextBlockTime: '2099-01-02T00:00:00.000Z', safeHead: '200',
        positions: [{
          tokenAddress: TOKEN, walletAddress: ALICE, quantityRaw: '10',
          throughBlock: '100', throughLogIndex: '5',
        }],
      },
    });
    assert.equal(first.committed, true);
    assert.equal(first.positionProjection.positions, 1);

    const conflict = await transfers.commitBatch({
      projectionVersion: ATOMIC_VERSION, stream: 'seed', expectedVersion: 1,
      nextBlock: '102', nextBlockTime: '2099-01-03T00:00:00.000Z', safeHead: '200',
      events: [{ ...event(101, 6, 20), classificationVersion: ATOMIC_VERSION }],
      positionBatch: {
        projectionVersion: POSITION_VERSION, stream: 'seed', expectedVersion: 0,
        nextBlock: '102', nextBlockTime: '2099-01-03T00:00:00.000Z', safeHead: '200',
        positions: [{
          tokenAddress: TOKEN, walletAddress: ALICE, quantityRaw: '30',
          throughBlock: '101', throughLogIndex: '6',
        }],
      },
    });
    assert.deepEqual(conflict, { committed: false, reason: 'position_cursor_conflict' });

    const edge = await db.query(
      `SELECT transfer_count::text FROM robinhood_wallet_transfer_edges
       WHERE classification_version = $1`, [ATOMIC_VERSION]
    );
    const position = await db.query(
      `SELECT quantity_raw::text FROM robinhood_wallet_token_positions
       WHERE projection_version = $1`, [POSITION_VERSION]
    );
    const transferCursor = await transfers.loadCursor(ATOMIC_VERSION, 'seed');
    const positionCursor = await positions.loadCursor(POSITION_VERSION, 'seed');
    assert.deepEqual(edge.rows, [{ transfer_count: '1' }]);
    assert.deepEqual(position.rows, [{ quantity_raw: '10' }]);
    assert.equal(transferCursor.version, 1);
    assert.equal(positionCursor.version, 1);
  });
});
