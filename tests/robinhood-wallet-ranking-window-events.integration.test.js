process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const {
  createRobinhoodWalletRankingWindowEventsRepository,
} = require('../src/models/robinhood-wallet-ranking-window-events');

const TOKEN = `0x${'a'.repeat(40)}`;
const WALLET_A = `0x${'1'.repeat(40)}`;
const WALLET_B = `0x${'2'.repeat(40)}`;
const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;
const HASH_C = `0x${'c'.repeat(64)}`;
const START = '2026-09-26T12:00:00.000Z';
const END = '2026-09-27T12:00:00.000Z';

async function seed(client) {
  await client.query(`CREATE TEMP TABLE robinhood_wallet_swaps (
    chain varchar, token_address varchar, wallet_address varchar,
    transaction_hash varchar, action_index bigint, block_number bigint,
    block_time timestamptz, side varchar, token_amount_raw numeric, volume_usd numeric
  ) ON COMMIT DROP`);
  await client.query(`CREATE TEMP TABLE robinhood_transaction_positions (
    chain varchar, transaction_hash varchar, block_number bigint,
    transaction_index int
  ) ON COMMIT DROP`);
  await client.query(`CREATE TEMP TABLE robinhood_token_transfer_events (
    chain varchar, token_address varchar, from_wallet varchar, to_wallet varchar,
    transaction_hash varchar, log_index int, block_number bigint,
    block_time timestamptz, transaction_index int, amount_raw numeric,
    transfer_kind varchar, classification_version varchar
  ) ON COMMIT DROP`);
  await client.query(
    `INSERT INTO robinhood_wallet_swaps VALUES
     ('robinhood', $1, $2, $3, 2, 100, '2026-09-27 00:00+00', 'buy', 10, 10),
     ('robinhood', $1, $2, $4, 1, 102, '2026-09-27 01:00+00', 'sell', 2, 6),
     ('robinhood', $1, $2, $5, 1, 90, '2026-09-26 11:59+00', 'buy', 7, 7)`,
    [TOKEN, WALLET_A, HASH_A, HASH_C, HASH_B]
  );
  await client.query(
    `INSERT INTO robinhood_transaction_positions VALUES
     ('robinhood', $1, 100, 0), ('robinhood', $2, 102, 0)`, [HASH_A, HASH_C]
  );
  await client.query(
    `INSERT INTO robinhood_token_transfer_events VALUES
     ('robinhood', $1, $2, $3, $4, 3, 100, '2026-09-27 00:00+00',
      0, 3, 'wallet_transfer', 'rh_transfer_v1'),
     ('robinhood', $1, $2, $3, $5, 4, 101, '2026-09-27 00:30+00',
      0, 2, 'dex_flow', 'rh_transfer_v1')`,
    [TOKEN, WALLET_A, WALLET_B, HASH_A, HASH_B]
  );
}

describe('Robinhood ranking in-window event read', () => {
  it('merges bounded swaps and wallet transfers in canonical order', async () => {
    await assertUsingTestDatabase(db);
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await seed(client);
      const repository = createRobinhoodWalletRankingWindowEventsRepository({
        database: { queryWithStatementTimeout: (sql, params) => client.query(sql, params) },
      });
      const input = { pairs: [
        { tokenAddress: TOKEN, walletAddress: WALLET_A },
        { tokenAddress: TOKEN, walletAddress: WALLET_B },
      ], windowStart: START, asOf: END, classificationVersion: 'rh_transfer_v1' };
      const [a, b] = await repository.getWindowEvents(input);
      assert.deepEqual(a.events.map(({ type }) => type), ['buy', 'transfer_out', 'sell']);
      assert.deepEqual(a.events.map(({ amountRaw }) => amountRaw), ['10', '3', '2']);
      assert.equal(a.events[0].volumeUsd, '10');
      assert.equal(a.truncated, false);
      assert.equal(a.orderingComplete, true);
      assert.equal(a.sourceCoverageVerified, false);
      assert.deepEqual(b.events.map(({ type }) => type), ['transfer_in']);

      const [limited] = await repository.getWindowEvents({ ...input, limitPerPair: 1 });
      assert.deepEqual(limited.events.map(({ type }) => type), ['buy', 'transfer_out']);
      assert.equal(limited.truncated, true);

      await client.query('DELETE FROM robinhood_transaction_positions WHERE transaction_hash=$1',
        [HASH_C]);
      const [missingIndex] = await repository.getWindowEvents(input);
      assert.equal(missingIndex.orderingComplete, false);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects oversized batches and windows before querying', async () => {
    const repository = createRobinhoodWalletRankingWindowEventsRepository({
      database: { queryWithStatementTimeout() { throw new Error('unexpected query'); } },
    });
    const pair = { tokenAddress: TOKEN, walletAddress: WALLET_A };
    const input = { pairs: [pair], windowStart: START, asOf: END,
      classificationVersion: 'rh_transfer_v1' };
    await assert.rejects(repository.getWindowEvents({ ...input, pairs: Array(21).fill(pair) }),
      /at most 20/);
    await assert.rejects(repository.getWindowEvents({ ...input, limitPerPair: 501 }),
      /at most 500|between 1 and 500/);
    await assert.rejects(repository.getWindowEvents({ ...input,
      windowStart: '2026-08-01T00:00:00.000Z',
    }), /at most 30 days/);
  });
});
