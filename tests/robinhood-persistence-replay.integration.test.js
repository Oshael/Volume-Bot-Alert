'use strict';

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const db = require('../src/models/db');
const { __private } = require('../src/models/robinhood-persistence');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const MARKET_KEY = `robinhood:uniswap-v2:0x${'1'.repeat(40)}`;
const TOKEN = `0x${'2'.repeat(40)}`;
const QUOTE = `0x${'3'.repeat(40)}`;
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
    await client.query(`INSERT INTO robinhood_market_observations VALUES
      ('robinhood',$1,1,100,'uniswap-v2',$2,$3,$4,'buy','accepted',
       '2026-09-19T10:30:05Z',2,200,20,NULL,'spot','medium',NULL,10),
      ('robinhood',$5,2,101,'uniswap-v2',$2,$3,$4,'sell','accepted',
       '2026-09-19T10:30:45Z',3,300,30,NULL,'spot','medium',NULL,5)`, [
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
});
