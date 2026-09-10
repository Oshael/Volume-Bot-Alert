'use strict';

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const db = require('../src/models/db');
const { STATEMENTS } = require('../src/utils/db-init-stage203');
const {
  createRobinhoodWalletSwapOutboxProducer,
} = require('../src/models/robinhood-wallet-swap-outbox-producer');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TX = `0x${'2'.repeat(64)}`;
const BLOCK = `0x${'3'.repeat(64)}`;
const WALLET = `0x${'4'.repeat(40)}`;
const TOKEN = `0x${'5'.repeat(40)}`;
const QUOTE = `0x${'6'.repeat(40)}`;
let client;

describe('Robinhood wallet-swap outbox producer integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    client = await db.getClient();
    await client.query(`CREATE TEMP TABLE robinhood_market_observations (
      chain text, transaction_hash text, log_index bigint, block_number bigint,
      protocol text, market_key text, token_address text, quote_address text,
      side text, status text, token_amount_raw numeric, quote_amount_raw numeric,
      token_decimals smallint, quote_decimals smallint, token_amount numeric,
      quote_amount numeric, price_usd numeric, volume_usd numeric, fdv_usd numeric,
      token_total_supply_raw numeric
    ); CREATE TEMP TABLE robinhood_processed_logs (
      chain text, transaction_hash text, log_index bigint, block_hash text
    ); CREATE TEMP TABLE robinhood_chain_blocks (
      chain text, block_number bigint, block_hash text, block_timestamp timestamptz,
      canonical boolean, head_observed_at timestamptz,
      receipts_available_at timestamptz, captured_at timestamptz
    ); CREATE TEMP TABLE robinhood_chain_transactions (
      chain text, block_hash text, transaction_hash text,
      transaction_index integer, from_address text
    )`);
    for (const [index, sql] of STATEMENTS.entries()) {
      await client.query(index === 0
        ? sql.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE')
        : sql);
    }
    await client.query(`INSERT INTO robinhood_market_observations VALUES (
      'robinhood',$1,9,100,'uniswap-v3','robinhood:uniswap-v3:test',$2,$3,
      'buy','accepted',1000,2000,18,6,1,2,2,2,2000000,1000000
    )`, [TX, TOKEN, QUOTE]);
    await client.query(
      `INSERT INTO robinhood_processed_logs VALUES ('robinhood',$1,9,$2)`, [TX, BLOCK]
    );
    await client.query(`INSERT INTO robinhood_chain_blocks VALUES (
      'robinhood',100,$1,'2026-09-10T08:00:00Z',TRUE,
      '2026-09-10T08:00:00.010Z','2026-09-10T08:00:00.020Z','2026-09-10T08:00:00.030Z'
    )`, [BLOCK]);
    await client.query(
      `INSERT INTO robinhood_chain_transactions VALUES ('robinhood',$1,$2,3,$3)`,
      [BLOCK, TX, WALLET]
    );
  });

  after(async () => {
    client?.release(true);
    await db.pool.end();
  });

  it('captures canonical context atomically and deduplicates replay', async () => {
    const producer = createRobinhoodWalletSwapOutboxProducer();
    const target = [{ transactionHash: TX, logIndex: '9' }];

    assert.deepEqual(await producer.appendAccepted(client, target), {
      requested: 1, eligible: 1, inserted: 1,
    });
    assert.deepEqual(await producer.appendAccepted(client, target), {
      requested: 1, eligible: 1, inserted: 0,
    });
    const stored = await client.query(
      `SELECT block_number::text, transaction_index, log_index::text, payload
       FROM robinhood_wallet_swap_outbox WHERE transaction_hash = $1`, [TX]
    );
    assert.equal(stored.rows[0].block_number, '100');
    assert.equal(stored.rows[0].transaction_index, 3);
    assert.equal(stored.rows[0].log_index, '9');
    assert.equal(stored.rows[0].payload.walletAddress, WALLET);
    assert.equal(stored.rows[0].payload.blockHash, BLOCK);
    assert.equal(stored.rows[0].payload.transactionIndex, '3');
    assert.equal(stored.rows[0].payload.parserVersion, 'rh-wallet-outbox-1');
  });

  it('rejects an accepted identity without committed canonical context', async () => {
    await assert.rejects(
      createRobinhoodWalletSwapOutboxProducer().appendAccepted(client, [{
        transactionHash: `0x${'7'.repeat(64)}`, logIndex: '1',
      }]),
      (error) => error.code === 'wallet_swap_canonical_context_missing'
    );
  });
});
