process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const { __private: { ANCHOR_COVERAGE_SQL } } = require(
  '../src/models/robinhood-bundle-funding-candidate-source'
);
const stage63 = require('../src/utils/db-init-stage63');
const stage116 = require('../src/utils/db-init-stage116');
const stage149 = require('../src/utils/db-init-stage149');
const stage155 = require('../src/utils/db-init-stage155');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'9'.repeat(40)}`;
const WALLET = `0x${'8'.repeat(40)}`;
const WALLET_2 = `0x${'5'.repeat(40)}`;
const POOL = `0x${'7'.repeat(40)}`;
const QUOTE = `0x${'6'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;
const TX_HASH = `0x${'b'.repeat(64)}`;
const MARKET = 'bundle-candidate-source-integration';

async function cleanup() {
  await db.query('DELETE FROM robinhood_wallet_token_first_buys WHERE token_address = $1', [TOKEN]);
  await db.query('DELETE FROM robinhood_token_launch_anchors WHERE token_address = $1', [TOKEN]);
  await db.query('DELETE FROM robinhood_holder_token_states WHERE token_address = $1', [TOKEN]);
  await db.query('DELETE FROM robinhood_pool_registry WHERE market_key = $1', [MARKET]);
}

describe('Robinhood bundle funding candidate source SQL', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    for (const stage of [stage63, stage116, stage149, stage155]) {
      await stage.init({ closePool: false });
    }
    await cleanup();
  });
  after(async () => { await cleanup(); await db.pool.end(); });

  it('counts covered tokens without multiplying first-buy wallets', async () => {
    await db.query(`INSERT INTO robinhood_pool_registry (
      protocol, market_key, pool_address, token_address, quote_address,
      currency0, currency1, discovery_block, discovery_block_hash,
      discovery_tx_hash, discovery_log_index, discovered_at
    ) VALUES ('uniswap-v2', $1, $2, $3, $4, $3, $4, 90, $5, $6, 0, NOW())`,
    [MARKET, POOL, TOKEN, QUOTE, HASH, TX_HASH]);
    await db.query(`INSERT INTO robinhood_holder_token_states (
      token_address, ledger_status, live_through_block, live_through_hash
    ) VALUES ($1, 'live', 200, $2)`, [TOKEN, HASH]);
    await db.query(`INSERT INTO robinhood_token_launch_anchors (
      token_address, first_pool_block, launch_block, source_through_block
    ) VALUES ($1, 90, 100, 200)`, [TOKEN]);
    await db.query(`INSERT INTO robinhood_wallet_token_first_buys (
      token_address, wallet_address, transaction_hash, transaction_index,
      action_index, block_number, block_hash, block_time, protocol, market_key,
      source_parser_version
    ) VALUES ($1, $2, $3, 0, 0, 101, $4, NOW(), 'uniswap-v2', $5, 'test-v1')`,
    [TOKEN, WALLET, TX_HASH, HASH, MARKET]);
    await db.query(`INSERT INTO robinhood_wallet_token_first_buys (
      token_address, wallet_address, transaction_hash, transaction_index,
      action_index, block_number, block_hash, block_time, protocol, market_key,
      source_parser_version
    ) VALUES ($1, $2, $3, 1, 1, 102, $4, NOW(), 'uniswap-v2', $5, 'test-v1')`,
    [TOKEN, WALLET_2, HASH, HASH, MARKET]);

    assert.deepEqual((await db.query(
      ANCHOR_COVERAGE_SQL, ['robinhood', '200']
    )).rows[0], { live_tokens: '1', first_buy_tokens: '1', anchored_tokens: '1' });
  });
});
