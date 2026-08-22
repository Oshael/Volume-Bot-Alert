process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage63 = require('../src/utils/db-init-stage63');
const stage149 = require('../src/utils/db-init-stage149');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'1'.repeat(40)}`;
const WALLET = `0x${'2'.repeat(40)}`;
const POOL = `0x${'3'.repeat(40)}`;
const QUOTE = `0x${'4'.repeat(40)}`;
const HASH = `0x${'5'.repeat(64)}`;
const TX = `0x${'6'.repeat(64)}`;
const MARKET = `robinhood:uniswap-v3:${POOL}`;

async function cleanup() {
  await db.query('DELETE FROM robinhood_wallet_token_first_buys WHERE token_address = $1', [TOKEN]);
  await db.query('DELETE FROM robinhood_pool_registry WHERE market_key = $1', [MARKET]);
}

describe('Robinhood wallet-token first buy schema integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage63.init({ closePool: false });
    await stage149.init({ closePool: false });
    await stage149.init({ closePool: false });
    await cleanup();
    await db.query(
      `INSERT INTO robinhood_pool_registry (
         protocol, market_key, pool_address, origin_address, token_address,
         quote_address, currency0, currency1, discovery_block,
         discovery_block_hash, discovery_tx_hash, discovery_log_index, discovered_at
       ) VALUES ('uniswap-v3', $1, $2, $2, $3, $4, $3, $4, 10,
         $5, $6, 0, '2026-08-22T12:00:00Z')`,
      [MARKET, POOL, TOKEN, QUOTE, HASH, TX]
    );
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('persists one canonical fact without classifier state', async () => {
    await db.query(
      `INSERT INTO robinhood_wallet_token_first_buys (
         token_address, wallet_address, transaction_hash, transaction_index,
         action_index, block_number, block_hash, block_time, protocol,
         market_key, volume_usd, source_parser_version
       ) VALUES ($1, $2, $3, 1, 2, 20, $4, '2026-08-22T12:01:00Z',
         'uniswap-v3', $5, 25.5, 'swap_only_v1')`,
      [TOKEN, WALLET, TX, HASH, MARKET]
    );
    const { rows } = await db.query(
      `SELECT block_number::text, volume_usd::text, evidence_version
         FROM robinhood_wallet_token_first_buys
        WHERE token_address = $1 AND wallet_address = $2`,
      [TOKEN, WALLET]
    );
    assert.deepEqual(rows[0], {
      block_number: '20', volume_usd: '25.5', evidence_version: 'rh_first_buy_v1',
    });
    await assert.rejects(db.query(
      `UPDATE robinhood_wallet_token_first_buys SET volume_usd = -1
        WHERE token_address = $1`, [TOKEN]
    ), /rh_wallet_token_first_buys_values_check/);
    await assert.rejects(db.query(
      `INSERT INTO robinhood_wallet_token_first_buys (
         token_address, wallet_address, transaction_hash, transaction_index,
         action_index, block_number, block_hash, block_time, protocol,
         market_key, source_parser_version
       ) VALUES ($1, $2, $3, 1, 3, 20, $4, '2026-08-22T12:01:00Z',
         'uniswap-v3', 'unknown-market', 'swap_only_v1')`,
      [TOKEN, `0x${'7'.repeat(40)}`, TX, HASH]
    ), /rh_wallet_token_first_buys_pool_fkey/);
  });
});
