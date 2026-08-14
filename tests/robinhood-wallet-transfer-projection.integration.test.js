process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const { createRobinhoodWalletTransferProjectionRepository } = require('../src/models/robinhood-wallet-transfer-projection');
const stage129 = require('../src/utils/db-init-stage129');
const stage130 = require('../src/utils/db-init-stage130');
const stage131 = require('../src/utils/db-init-stage131');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const VERSION = 'test_transfer_projection_v1';
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
  await db.query('DELETE FROM robinhood_wallet_relationship_evidence WHERE algorithm_version = $1', [VERSION]);
  await db.query('DELETE FROM robinhood_wallet_transfer_edges WHERE classification_version = $1', [VERSION]);
  await db.query('DELETE FROM robinhood_wallet_transfer_daily_summaries WHERE projection_version = $1', [VERSION]);
  await db.query('DELETE FROM robinhood_wallet_transfer_cursors WHERE projection_version = $1', [VERSION]);
}

describe('Robinhood wallet transfer projection persistence', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage129.init({ closePool: false });
    await stage130.init({ closePool: false });
    await stage131.init({ closePool: false });
    await cleanup();
  });
  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('commits edges, bounded evidence and cursor atomically', async () => {
    const repository = createRobinhoodWalletTransferProjectionRepository({ database: db });
    await repository.initCursor({
      projectionVersion: VERSION, stream: 'seed', nextBlock: '100',
      nextBlockTime: '2099-01-01T00:00:00.000Z', safeHead: '200',
    });
    const first = await repository.commitBatch({
      projectionVersion: VERSION, stream: 'seed', expectedVersion: 0,
      nextBlock: '101', nextBlockTime: '2099-01-02T00:00:00.000Z', safeHead: '200',
      checkpointBlock: '100', checkpointHash: `0x${'f'.repeat(64)}`,
      summarizedThroughDay: '2099-01-01',
      events: [event(100, 5, 10), event(100, 7, 30), event(100, 8, 20, 'dex_flow')],
    });
    assert.equal(first.committed, true);
    assert.equal(first.cursor.version, 1);
    assert.deepEqual(
      { edges: first.edgeGroups, daily: first.dailySummaryGroups, evidence: first.evidenceCandidates },
      { edges: 1, daily: 1, evidence: 3 }
    );

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
      summarizedThroughDay: '2099-01-02', events: [event(101, 1, 40)],
    });
    assert.equal(second.cursor.version, 2);
    assert.equal(second.cursor.safeHead, '200');

    const edge = await db.query(
      `SELECT transfer_count::text, total_amount_raw::text,
              wallet_transfer_count::text, dex_flow_count::text,
              first_block::text, first_log_index, last_block::text, last_log_index,
              largest_amount_raw::text, largest_log_index
       FROM robinhood_wallet_transfer_edges WHERE classification_version = $1`,
      [VERSION]
    );
    assert.deepEqual(edge.rows[0], {
      transfer_count: '4', total_amount_raw: '100', wallet_transfer_count: '3',
      dex_flow_count: '1', first_block: '100', first_log_index: 5,
      last_block: '101', last_log_index: 1, largest_amount_raw: '40', largest_log_index: 1,
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
        summary_day: '2099-01-01', transfer_count: '3', total_amount_raw: '60',
        wallet_transfer_count: '2', wallet_transfer_amount_raw: '40',
        dex_flow_count: '1', dex_flow_amount_raw: '20', through_block: '100',
        through_transaction_index: 8, through_log_index: 8,
      },
      {
        summary_day: '2099-01-02', transfer_count: '1', total_amount_raw: '40',
        wallet_transfer_count: '1', wallet_transfer_amount_raw: '40',
        dex_flow_count: '0', dex_flow_amount_raw: '0', through_block: '101',
        through_transaction_index: 1, through_log_index: 1,
      },
    ]);
    const evidence = await db.query(
      `SELECT evidence_role, evidence_block::text, evidence_log_index
       FROM robinhood_wallet_relationship_evidence
       WHERE algorithm_version = $1 ORDER BY evidence_role`,
      [VERSION]
    );
    assert.deepEqual(evidence.rows, [
      { evidence_role: 'first', evidence_block: '100', evidence_log_index: 5 },
      { evidence_role: 'largest', evidence_block: '101', evidence_log_index: 1 },
      { evidence_role: 'last', evidence_block: '101', evidence_log_index: 1 },
    ]);
  });
});
