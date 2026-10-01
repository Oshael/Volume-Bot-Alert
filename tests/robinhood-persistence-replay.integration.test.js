'use strict';

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const db = require('../src/models/db');
const { __private } = require('../src/models/robinhood-persistence');
const { rebuildArchiveMinute } = require('../src/models/robinhood-archive-minute-rebuild');
const { STOCKS } = require('../src/services/robinhood-archive-replay-scope');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const MARKET_KEY = `robinhood:uniswap-v2:0x${'1'.repeat(40)}`;
const TOKEN = `0x${'2'.repeat(40)}`;
const QUOTE = STOCKS[0];
let client;

describe('Robinhood processing replay projections', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    client = await db.getClient();
    await client.query(`CREATE TEMP TABLE robinhood_market_observations (
      chain text NOT NULL, transaction_hash text NOT NULL, log_index bigint NOT NULL,
      block_number bigint NOT NULL, protocol text NOT NULL, market_key text NOT NULL,
      token_address text NOT NULL, quote_address text NOT NULL, side text NOT NULL,
      status text NOT NULL, observed_at timestamptz NOT NULL,
      price_usd numeric, fdv_usd numeric, liquidity_usd numeric, liquidity_raw numeric,
      liquidity_status text, liquidity_confidence text, liquidity_warning text,
      volume_usd numeric NOT NULL
    ); CREATE TEMP TABLE robinhood_market_buckets_1m (
      chain text NOT NULL, protocol text NOT NULL, market_key text NOT NULL,
      token_address text NOT NULL, quote_address text NOT NULL, bucket_ts timestamptz NOT NULL,
      open_price_usd numeric, high_price_usd numeric, low_price_usd numeric,
      close_price_usd numeric, open_fdv_usd numeric, high_fdv_usd numeric,
      low_fdv_usd numeric, close_fdv_usd numeric, close_liquidity_usd numeric,
      close_liquidity_raw numeric, close_liquidity_status text,
      close_liquidity_confidence text, close_liquidity_warning text,
      volume_usd numeric NOT NULL, swaps bigint NOT NULL, buys bigint NOT NULL,
      sells bigint NOT NULL, transactions bigint NOT NULL,
      first_observed_at timestamptz, first_block_number bigint, first_log_index bigint,
      last_observed_at timestamptz, last_block_number bigint, last_log_index bigint,
      expires_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT NOW(),
      UNIQUE (chain, protocol, market_key, bucket_ts)
    )`);
    await client.query(`CREATE TEMP TABLE robinhood_market_buckets_1h
      (LIKE public.robinhood_market_buckets_1h INCLUDING ALL);
      CREATE TEMP TABLE robinhood_wallet_ranking_revisions
      (LIKE public.robinhood_wallet_ranking_revisions INCLUDING ALL)`);
    await client.query(`INSERT INTO robinhood_market_observations VALUES
      ('robinhood',$1,1,100,'uniswap-v2',$2,$3,$4,'buy','accepted',
       '2026-09-19T10:30:05Z',2,200,20,NULL,'spot_estimate_from_double_quote_reserve','medium',NULL,10),
      ('robinhood',$5,2,101,'uniswap-v2',$2,$3,$4,'sell','accepted',
       '2026-09-19T10:30:45Z',3,300,30,NULL,'spot_estimate_from_double_quote_reserve','medium',NULL,5)`, [
      `0x${'a'.repeat(64)}`, MARKET_KEY, TOKEN, QUOTE, `0x${'b'.repeat(64)}`,
    ]);
  });

  after(async () => {
    client?.release(true);
    await db.pool.end();
  });

  it('rebuilds a missing minute from accepted observations without double counting replay', async () => {
    const targets = [{
      status: 'accepted', protocol: 'uniswap-v2', marketKey: MARKET_KEY,
      observedAt: '2026-09-19T10:30:05Z',
    }];

    assert.equal(await __private.rebuildReplayMinuteBuckets(client, targets), 1);
    let bucket = (await client.query(`SELECT volume_usd::text, swaps::text,
      buys::text, sells::text, transactions::text,
      open_price_usd::text, close_price_usd::text
      FROM robinhood_market_buckets_1m`)).rows[0];
    assert.deepEqual(bucket, {
      volume_usd: '15', swaps: '2', buys: '1', sells: '1', transactions: '2',
      open_price_usd: '2', close_price_usd: '3',
    });

    await client.query(`UPDATE robinhood_market_buckets_1m
      SET volume_usd=999, swaps=99, buys=99, sells=99, transactions=99`);
    assert.equal(await __private.rebuildReplayMinuteBuckets(client, targets), 1);
    bucket = (await client.query(`SELECT volume_usd::text, swaps::text,
      buys::text, sells::text, transactions::text
      FROM robinhood_market_buckets_1m`)).rows[0];
    assert.deepEqual(bucket, {
      volume_usd: '15', swaps: '2', buys: '1', sells: '1', transactions: '2',
    });
  });

  it('corrects retained Stock volume, preserves other markets and rejects incomplete minutes transactionally', async () => {
    const database = { getClient: async () => ({ query: client.query.bind(client), release() {} }) };
    const minute = '2026-09-19T10:30:00Z';
    const rows = ['a', 'b'].map((value, index) => ({ transaction_hash: `0x${value.repeat(64)}`,
      log_index: String(index + 1), block_number: String(100 + index),
      protocol: 'uniswap-v2', market_key: MARKET_KEY, token_address: TOKEN, quote_address: QUOTE }));
    await client.query(`INSERT INTO robinhood_market_buckets_1m
      SELECT chain, protocol, market_key || ':other', token_address, quote_address, bucket_ts,
        open_price_usd, high_price_usd, low_price_usd, close_price_usd,
        open_fdv_usd, high_fdv_usd, low_fdv_usd, close_fdv_usd,
        close_liquidity_usd, close_liquidity_raw, close_liquidity_status,
        close_liquidity_confidence, close_liquidity_warning,
        77, swaps, buys, sells, transactions, first_observed_at, first_block_number,
        first_log_index, last_observed_at, last_block_number, last_log_index, expires_at, updated_at
      FROM robinhood_market_buckets_1m`);
    await client.query('UPDATE robinhood_market_buckets_1m SET volume_usd=999 WHERE market_key=$1', [MARKET_KEY]);
    assert.deepEqual(await rebuildArchiveMinute(database, rows, minute), { minutes: 1, hours: 1 });
    assert.deepEqual(await rebuildArchiveMinute(database, rows, minute), { minutes: 1, hours: 1 });
    const volumes = async () => (await client.query(`SELECT volume_usd::text FROM robinhood_market_buckets_1m
      ORDER BY market_key`)).rows.map((row) => row.volume_usd);
    assert.deepEqual(await volumes(), ['15', '77']);
    assert.equal((await client.query('SELECT volume_usd::text FROM robinhood_market_buckets_1h')).rows[0].volume_usd, '15');
    await assert.rejects(rebuildArchiveMinute(database, rows.slice(0, 1), minute), /absent from archive/);
    assert.deepEqual(await volumes(), ['15', '77']);
    await client.query("UPDATE robinhood_market_observations SET status='pending' WHERE block_number=101");
    await assert.rejects(rebuildArchiveMinute(database, rows, minute), /missing, pending or conflicting/);
    assert.deepEqual(await volumes(), ['15', '77']);
    await client.query("UPDATE robinhood_market_observations SET status='rejected'");
    await assert.rejects(rebuildArchiveMinute(database, rows, minute), /no accepted archive observations/);
    assert.deepEqual(await volumes(), ['15', '77']);
  });
});
