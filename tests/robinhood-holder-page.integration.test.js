const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHolderPageRepository,
  __private,
} = require('../src/models/robinhood-holder-page');

const TOKEN = `0x${'a'.repeat(40)}`;
const SHADOW_TOKEN = `0x${'b'.repeat(40)}`;
const DEAD = '0x000000000000000000000000000000000000dead';
const POOL = `0x${'c'.repeat(40)}`;

after(() => db.pool.end());

describe('Robinhood published holder page persistence', () => {
  it('paginates the live ledger by balance and refuses unpublished states', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TEMP TABLE robinhood_holder_token_states
        (LIKE public.robinhood_holder_token_states INCLUDING ALL)`);
      await client.query(`CREATE TEMP TABLE robinhood_holder_balances
        (LIKE public.robinhood_holder_balances INCLUDING ALL)`);
      await client.query(`CREATE TEMP TABLE robinhood_holder_cursors
        (LIKE public.robinhood_holder_cursors INCLUDING ALL)`);
      await client.query(`CREATE TEMP TABLE robinhood_pool_registry (
        chain varchar(32) NOT NULL, pool_address varchar(42)
      )`);
      await client.query(
        `INSERT INTO robinhood_holder_token_states (
           token_address, holder_count, ledger_status, updated_at
         ) VALUES ($1, 52, 'live', '2026-08-14T03:00:00Z'),
                  ($2, 1, 'shadow', '2026-08-14T03:00:00Z')`,
        [TOKEN, SHADOW_TOKEN]
      );
      await client.query(
        `INSERT INTO robinhood_holder_cursors (next_block, safe_head, updated_at)
         VALUES (200, 199, '2026-08-14T03:00:01Z')`
      );
      await client.query(`INSERT INTO robinhood_pool_registry VALUES ('robinhood', $1)`, [POOL]);
      const wallets = [DEAD, POOL, ...Array.from({ length: 50 }, (_, index) => (
        `0x${(index + 1).toString(16).padStart(40, '0')}`
      ))];
      await client.query(
        `INSERT INTO robinhood_holder_balances (
           token_address, wallet_address, balance_raw, last_block_number,
           last_transaction_hash, last_log_index
         ) SELECT $1, item.wallet, item.balance::numeric, 100,
                  '0x${'1'.repeat(64)}', item.ordinality
             FROM unnest($2::varchar[], $3::varchar[])
                  WITH ORDINALITY AS item(wallet, balance, ordinality)`,
        [TOKEN, wallets, wallets.map((_, index) => String(10_000 - Math.floor(index / 2)))]
      );
      await client.query(
        `INSERT INTO robinhood_holder_balances (
           token_address, wallet_address, balance_raw, last_block_number,
           last_transaction_hash, last_log_index
         ) VALUES ($1, $2, 1, 100, '0x${'2'.repeat(64)}', 1)`,
        [SHADOW_TOKEN, wallets[2]]
      );

      await client.query(`CREATE TEMP TABLE robinhood_market_observations (
        chain varchar(16) NOT NULL, token_address varchar(42) NOT NULL,
        status varchar(16) NOT NULL, token_total_supply_raw numeric(78, 0),
        observed_at timestamptz NOT NULL
      )`);
      await client.query(
        `INSERT INTO robinhood_market_observations
           (chain, token_address, status, token_total_supply_raw, observed_at)
         VALUES ('robinhood', $1, 'accepted', 900000, '2026-08-14T02:00:00Z'),
                ('robinhood', $1, 'accepted', 1000000, '2026-08-14T03:00:00Z'),
                ('robinhood', $1, 'rejected', 5, '2026-08-14T04:00:00Z')`,
        [TOKEN]
      );

      const repository = createRobinhoodHolderPageRepository({
        database: { query: client.query.bind(client) },
      });
      const first = await repository.listPublishedPage({ tokenAddress: TOKEN });
      assert.equal(first.holderCount, 52);
      assert.equal(first.totalSupplyRaw, '1000000');
      assert.equal(first.checkedAt, '2026-08-14T03:00:01.000Z');
      assert.equal(first.items.length, __private.PAGE_SIZE);
      assert.equal(first.hasMore, true);
      assert.match(first.nextCursor, /^ledger_v1\./);
      assert.equal(first.items[0].addressType, 'burn');
      assert.equal(first.items[1].addressType, 'pool');
      assert.equal(first.items[2].addressType, 'unknown');

      const second = await repository.listPublishedPage({
        tokenAddress: TOKEN, cursor: first.nextCursor,
      });
      assert.equal(second.items.length, 2);
      assert.deepEqual(second.items.map((item) => item.rank), [51, 52]);
      assert.equal(second.hasMore, false);
      assert.equal(second.nextCursor, null);
      assert.equal(await repository.listPublishedPage({ tokenAddress: SHADOW_TOKEN }), null);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});
