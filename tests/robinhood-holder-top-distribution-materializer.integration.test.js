process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHolderTopDistributionMaterializer,
} = require('../src/services/robinhood-holder-top-distribution-materializer');
const stage113 = require('../src/utils/db-init-stage113');
const stage114 = require('../src/utils/db-init-stage114');
const stage144 = require('../src/utils/db-init-stage144');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'6'.repeat(40)}`;
const EMPTY_TOKEN = `0x${'7'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;
const TX = `0x${'b'.repeat(64)}`;

async function cleanup() {
  const tokens = [TOKEN, EMPTY_TOKEN];
  await db.query(
    'DELETE FROM robinhood_holder_distribution_metrics WHERE token_address = ANY($1)', [tokens]
  );
  await db.query('DELETE FROM robinhood_holder_balances WHERE token_address = ANY($1)', [tokens]);
  await db.query(
    'DELETE FROM robinhood_holder_token_states WHERE token_address = ANY($1)', [tokens]
  );
}

describe('Robinhood Top 10/50 distribution materializer integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage113.init({ closePool: false });
    await stage114.init({ closePool: false });
    await stage144.init({ closePool: false });
    await cleanup();
    await db.query(
      `INSERT INTO robinhood_holder_token_states (
         token_address, holder_count, ledger_status, live_through_block, live_through_hash
       ) VALUES ($1, 60, 'live', 200, $3), ($2, 0, 'live', 200, $3)`,
      [TOKEN, EMPTY_TOKEN, HASH]
    );
    const balances = Array.from({ length: 60 }, (_, index) => ({
      token_address: TOKEN,
      wallet_address: `0x${(index + 1).toString(16).padStart(40, '0')}`,
      balance_raw: String(index + 1),
      block_number: '200', transaction_hash: TX, log_index: String(index),
    }));
    await db.query(
      `INSERT INTO robinhood_holder_balances (
         chain, token_address, wallet_address, balance_raw, last_block_number,
         last_transaction_hash, last_log_index
       ) SELECT 'robinhood', item.token_address, item.wallet_address,
                item.balance_raw::numeric, item.block_number::bigint,
                item.transaction_hash, item.log_index::bigint
           FROM jsonb_to_recordset($1::jsonb) AS item(
             token_address text, wallet_address text, balance_raw text,
             block_number text, transaction_hash text, log_index text
           )`,
      [JSON.stringify(balances)]
    );
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('publishes exact ranked balances and actual wallet counts at the live frontier', async () => {
    const materializer = createRobinhoodHolderTopDistributionMaterializer({
      database: db, now: () => '2026-08-27T12:00:00Z',
    });

    assert.deepEqual(await materializer.materializeToken(TOKEN), {
      status: 'published', metrics: [{ status: 'published' }, { status: 'published' }],
    });
    const result = await db.query(
      `SELECT metric, status, value_numerator_raw::text, value_denominator_raw::text,
              wallet_count::text, through_block_number::text
         FROM robinhood_holder_distribution_metrics
        WHERE token_address = $1 AND metric IN ('top10', 'top50') ORDER BY metric`,
      [TOKEN]
    );
    assert.deepEqual(result.rows, [{
      metric: 'top10', status: 'ready', value_numerator_raw: '555',
      value_denominator_raw: '1830', wallet_count: '10', through_block_number: '200',
    }, {
      metric: 'top50', status: 'ready', value_numerator_raw: '1775',
      value_denominator_raw: '1830', wallet_count: '50', through_block_number: '200',
    }]);
  });

  it('publishes unavailable instead of an invented zero when supply is absent', async () => {
    const materializer = createRobinhoodHolderTopDistributionMaterializer({
      database: db, now: () => '2026-08-27T12:00:00Z',
    });

    await materializer.materializeToken(EMPTY_TOKEN);
    const result = await db.query(
      `SELECT metric, status, status_reason, value_numerator_raw
         FROM robinhood_holder_distribution_metrics
        WHERE token_address = $1 AND metric IN ('top10', 'top50') ORDER BY metric`,
      [EMPTY_TOKEN]
    );
    assert.deepEqual(result.rows, [{
      metric: 'top10', status: 'unavailable', status_reason: 'supply_unavailable',
      value_numerator_raw: null,
    }, {
      metric: 'top50', status: 'unavailable', status_reason: 'supply_unavailable',
      value_numerator_raw: null,
    }]);
  });
});
