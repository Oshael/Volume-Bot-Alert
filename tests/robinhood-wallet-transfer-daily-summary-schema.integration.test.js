process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage131 = require('../src/utils/db-init-stage131');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const VERSION = 'test_transfer_daily_v1';
const TOKEN = `0x${'1'.repeat(40)}`;

async function cleanup() {
  await db.query(
    'DELETE FROM robinhood_wallet_transfer_daily_summaries WHERE projection_version = $1',
    [VERSION]
  );
}

async function insertSummary(overrides = {}) {
  const values = {
    day: '2099-01-01', token: TOKEN, transferCount: 3, totalAmount: '60',
    walletCount: 2, walletAmount: '40', dexCount: 1, dexAmount: '20',
    block: 100, transactionIndex: 4, logIndex: 7,
    blockTime: '2099-01-01T23:59:59.000Z', ...overrides,
  };
  return db.query(
    `INSERT INTO robinhood_wallet_transfer_daily_summaries (
       chain, projection_version, summary_day, token_address,
       transfer_count, total_amount_raw, wallet_transfer_count,
       wallet_transfer_amount_raw, dex_flow_count, dex_flow_amount_raw,
       through_block, through_transaction_index, through_log_index, through_block_time
     ) VALUES ('robinhood', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [VERSION, values.day, values.token, values.transferCount, values.totalAmount,
      values.walletCount, values.walletAmount, values.dexCount, values.dexAmount,
      values.block, values.transactionIndex, values.logIndex, values.blockTime]
  );
}

describe('Robinhood wallet transfer daily summary schema integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage131.init({ closePool: false });
    await cleanup();
  });
  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('stores exact totals idempotently and rejects unreconcilable rows', async () => {
    await insertSummary();
    await stage131.init({ closePool: false });

    const stored = await db.query(
      `SELECT transfer_count::text, total_amount_raw::text,
              wallet_transfer_count::text, dex_flow_count::text,
              through_block::text, through_log_index
       FROM robinhood_wallet_transfer_daily_summaries
       WHERE projection_version = $1`,
      [VERSION]
    );
    assert.deepEqual(stored.rows[0], {
      transfer_count: '3', total_amount_raw: '60', wallet_transfer_count: '2',
      dex_flow_count: '1', through_block: '100', through_log_index: 7,
    });
    await assert.rejects(
      insertSummary({ token: `0x${'2'.repeat(40)}`, dexCount: 2 }),
      /rh_wallet_transfer_daily_summaries_totals_check/
    );
    await assert.rejects(
      insertSummary({ token: `0x${'3'.repeat(40)}`, blockTime: '2099-01-02T00:00:00.000Z' }),
      /rh_wallet_transfer_daily_summaries_frontier_check/
    );
  });
});
