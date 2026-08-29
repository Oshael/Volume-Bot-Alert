process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodWalletTokenFirstBuyRepository,
} = require('../src/models/robinhood-wallet-token-first-buy');
const {
  createRobinhoodTransactionPositionRepairRepository,
} = require('../src/models/robinhood-transaction-position-repair');
const stage63 = require('../src/utils/db-init-stage63');
const stage90 = require('../src/utils/db-init-stage90');
const stage139 = require('../src/utils/db-init-stage139');
const stage149 = require('../src/utils/db-init-stage149');
const stage171 = require('../src/utils/db-init-stage171');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'1'.repeat(40)}`;
const WALLET = `0x${'2'.repeat(40)}`;
const POOL = `0x${'3'.repeat(40)}`;
const QUOTE = `0x${'4'.repeat(40)}`;
const HASH = `0x${'5'.repeat(64)}`;
const TX = `0x${'6'.repeat(64)}`;
const MARKET = `robinhood:uniswap-v3:${POOL}`;
const PARTITION = 'robinhood_wallet_swaps_first_buy_test';
const SWAP_HASHES = [7, 8, 9, 11].map((digit) => `0x${digit.toString(16).repeat(64)}`);

async function cleanup() {
  await db.query('DELETE FROM robinhood_launch_anchor_outbox WHERE token_address = $1', [TOKEN]);
  await db.query('DELETE FROM robinhood_wallet_token_first_buys WHERE token_address = $1', [TOKEN]);
  await db.query(`DELETE FROM ${PARTITION}`);
  await db.query(
    `DELETE FROM robinhood_transaction_positions
      WHERE transaction_hash IN ($1, $2, $3, $4)`, SWAP_HASHES
  );
  await db.query('DELETE FROM robinhood_pool_registry WHERE market_key = $1', [MARKET]);
}

describe('Robinhood wallet-token first buy schema integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage63.init({ closePool: false });
    await stage90.init({ closePool: false });
    await stage139.init({ closePool: false });
    await stage149.init({ closePool: false });
    await stage171.init({ closePool: false });
    await stage149.init({ closePool: false });
    await db.query(
      `CREATE TABLE IF NOT EXISTS ${PARTITION}
       PARTITION OF robinhood_wallet_swaps
       FOR VALUES FROM ('2099-01-01T00:00:00Z') TO ('2099-01-04T00:00:00Z')`
    );
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
    assert.equal((await db.query(
      'SELECT status FROM robinhood_launch_anchor_outbox WHERE token_address = $1', [TOKEN]
    )).rows[0].status, 'pending');
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

  it('replaces out-of-order facts and fails closed on missing positions', async () => {
    await db.query('DELETE FROM robinhood_wallet_token_first_buys WHERE token_address = $1', [TOKEN]);
    await db.query(
      `INSERT INTO robinhood_transaction_positions
         (transaction_hash, block_number, block_hash, transaction_index)
       VALUES ($1, 30, $4, 2), ($2, 20, $4, 1), ($3, 20, $4, 0)`,
      [SWAP_HASHES[0], SWAP_HASHES[1], SWAP_HASHES[3], HASH]
    );
    await db.query(
      `INSERT INTO ${PARTITION} (
         wallet_address, transaction_hash, action_index, block_number, block_time,
         protocol, market_key, token_address, quote_address, side,
         token_amount_raw, quote_amount_raw, volume_usd, parser_version
       ) VALUES
         ($1, $3, 0, 30, '2099-01-02T01:00:00Z', 'uniswap-v3', $6, $2, $7,
          'buy', 1, 1, 30, 'swap_only_v1'),
         ($1, $4, 0, 20, '2099-01-01T01:00:00Z', 'uniswap-v3', $6, $2, $7,
          'buy', 1, 1, 20, 'swap_only_v1'),
         ($1, $5, 0, 20, '2099-01-01T01:00:01Z', 'uniswap-v3', $6, $2, $7,
          'buy', 1, 1, 21, 'swap_only_v1'),
         ($8, $9, 0, 40, '2099-01-03T01:00:00Z', 'uniswap-v3', $6, $2, $7,
          'buy', 1, 1, 40, 'swap_only_v1')`,
      [WALLET, TOKEN, SWAP_HASHES[0], SWAP_HASHES[1], SWAP_HASHES[3], MARKET, QUOTE,
        `0x${'a'.repeat(40)}`, SWAP_HASHES[2]]
    );
    const repair = createRobinhoodTransactionPositionRepairRepository({ database: db });
    assert.deepEqual(await repair.listMissing({
      rangeStart: '2099-01-03T00:00:00Z', rangeEnd: '2099-01-04T00:00:00Z',
    }), [{
      transaction_hash: SWAP_HASHES[2], block_number: '40', transaction_index: null,
    }]);
    const repository = createRobinhoodWalletTokenFirstBuyRepository({ database: db });
    await repository.materializeRange({
      rangeStart: '2099-01-02T00:00:00Z', rangeEnd: '2099-01-03T00:00:00Z',
    });
    await repository.materializeRange({
      rangeStart: '2099-01-01T00:00:00Z', rangeEnd: '2099-01-02T00:00:00Z',
    });
    const persisted = await db.query(
      `SELECT transaction_hash, block_number::text
         FROM robinhood_wallet_token_first_buys
        WHERE token_address = $1 AND wallet_address = $2`, [TOKEN, WALLET]
    );
    assert.deepEqual(persisted.rows[0], {
      transaction_hash: SWAP_HASHES[3], block_number: '20',
    });
    await assert.rejects(repository.materializeRange({
      rangeStart: '2099-01-03T00:00:00Z', rangeEnd: '2099-01-04T00:00:00Z',
    }), (error) => error.code === 'first_buy_position_unavailable');
  });
});
