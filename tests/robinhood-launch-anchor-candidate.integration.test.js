process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const {
  __private: { LOAD_CANDIDATE_SQL },
} = require('../src/models/robinhood-launch-anchor-outbox');

const TOKENS = [1, 2, 3].map((digit) => `0x${String(digit).repeat(40)}`);
const HASH = `0x${'a'.repeat(64)}`;

after(() => db.pool.end());

it('bounds launch lookup by the first eligible buy, skipping earlier ineligible buys',
  async () => {
    await assertUsingTestDatabase(db);
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TEMP TABLE robinhood_holder_token_states (
        chain text, token_address text, ledger_status text,
        live_through_block bigint, live_through_hash text
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE robinhood_chain_blocks (
        chain text, canonical boolean, block_number bigint, block_hash text
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE robinhood_pool_registry (
        chain text, protocol text, market_key text, token_address text,
        discovery_block bigint, discovered_at timestamptz, active boolean,
        PRIMARY KEY (chain, protocol, market_key)
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE robinhood_wallet_token_first_buys (
        chain text, token_address text, protocol text, market_key text,
        block_number bigint, block_time timestamptz,
        transaction_index integer, action_index bigint, transaction_hash text
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE robinhood_wallet_swaps (
        chain text, token_address text, protocol text, market_key text,
        block_number bigint, block_time timestamptz,
        action_index bigint, transaction_hash text
      ) ON COMMIT DROP`);

      await client.query(`INSERT INTO robinhood_chain_blocks
        VALUES ('robinhood', true, 300, $1)`, [HASH]);
      for (const tokenAddress of TOKENS) {
        await client.query(`INSERT INTO robinhood_holder_token_states
          VALUES ('robinhood', $1, 'live', 300, $2)`, [tokenAddress, HASH]);
      }

      const insertPool = (tokenAddress, marketKey, discoveryBlock, active) => (
        client.query(`INSERT INTO robinhood_pool_registry VALUES (
          'robinhood', 'uniswap-v2', $1, $2, $3,
          TIMESTAMPTZ '2026-01-01' + $3::bigint * INTERVAL '1 second', $4
        )`, [marketKey, tokenAddress, discoveryBlock, active])
      );
      const insertBuy = (tokenAddress, marketKey, blockNumber, hashDigit) => (
        client.query(`INSERT INTO robinhood_wallet_token_first_buys VALUES (
          'robinhood', $1, 'uniswap-v2', $2, $3,
          TIMESTAMPTZ '2026-01-01' + $3::bigint * INTERVAL '1 second',
          0, 0, $4
        )`, [tokenAddress, marketKey, blockNumber,
          `0x${String(hashDigit).repeat(64)}`])
      );
      const insertSwap = (tokenAddress, marketKey, blockNumber, hashDigit) => (
        client.query(`INSERT INTO robinhood_wallet_swaps VALUES (
          'robinhood', $1, 'uniswap-v2', $2, $3,
          TIMESTAMPTZ '2026-01-01' + $3::bigint * INTERVAL '1 second',
          0, $4
        )`, [tokenAddress, marketKey, blockNumber,
          `0x${String(hashDigit).repeat(64)}`])
      );

      await insertPool(TOKENS[0], 'late', 120, true);
      await insertBuy(TOKENS[0], 'late', 100, '1');
      await insertBuy(TOKENS[0], 'late', 130, '2');
      await insertSwap(TOKENS[0], 'late', 100, '1');
      await insertSwap(TOKENS[0], 'late', 125, '3');
      await insertSwap(TOKENS[0], 'late', 130, '2');

      await insertPool(TOKENS[1], 'never-ready', 200, true);
      await insertBuy(TOKENS[1], 'never-ready', 150, '4');
      await insertBuy(TOKENS[1], 'never-ready', 180, '5');
      await insertSwap(TOKENS[1], 'never-ready', 150, '4');

      await insertPool(TOKENS[2], 'inactive', 80, false);
      await insertPool(TOKENS[2], 'active', 100, true);
      await client.query(`INSERT INTO robinhood_wallet_token_first_buys
        SELECT 'robinhood', $1, 'uniswap-v2', 'inactive', block,
          TIMESTAMPTZ '2026-01-01' + block * INTERVAL '1 second',
          0, 0, '0x' || LPAD(TO_HEX(block), 64, '0')
        FROM generate_series(1, 99) AS block`, [TOKENS[2]]);
      await insertBuy(TOKENS[2], 'inactive', 105, '6');
      await insertBuy(TOKENS[2], 'active', 110, '7');
      await insertSwap(TOKENS[2], 'inactive', 90, '6');
      await insertSwap(TOKENS[2], 'active', 110, '7');

      const candidates = [];
      for (const tokenAddress of TOKENS) {
        const { rows } = await client.query(LOAD_CANDIDATE_SQL,
          ['robinhood', tokenAddress]);
        candidates.push(rows[0]);
      }
      assert.deepEqual(candidates.map((candidate) => ({
        readiness: candidate.readiness,
        firstPoolBlock: candidate.first_pool_block,
        upperBlock: candidate.upper_block,
        launchBlock: candidate.launch_block,
      })), [
        { readiness: 'ready', firstPoolBlock: '120', upperBlock: '130',
          launchBlock: '125' },
        { readiness: 'eligible_first_buy_missing', firstPoolBlock: '200',
          upperBlock: null, launchBlock: null },
        { readiness: 'ready', firstPoolBlock: '100', upperBlock: '110',
          launchBlock: '110' },
      ]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
