process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage65 = require('../src/utils/db-init-stage65');
const stage66 = require('../src/utils/db-init-stage66');
const stage78 = require('../src/utils/db-init-stage78');
const stage105 = require('../src/utils/db-init-stage105');
const { assertUsingTestDatabase } = require('./helpers/test-db');

// A bucket for an uncapped-supply token carries a null FDV (buildMarketObservation
// suppresses it). Before stage 105 the *_fdv_usd columns were NOT NULL, so this
// insert would fail and halt the commit. This proves the migration lets the row
// land while the >= 0 / high >= low CHECK stays satisfied (NULL never violates it).
const MARKET_KEY = 'robinhood:uniswap-v3:null-fdv-integration';

async function insertNullFdvBucket() {
  return db.query(
    `INSERT INTO robinhood_market_buckets_1m (
       protocol, market_key, token_address, quote_address, bucket_ts,
       open_price_usd, high_price_usd, low_price_usd, close_price_usd,
       open_fdv_usd, high_fdv_usd, low_fdv_usd, close_fdv_usd,
       volume_usd, swaps, buys, sells, transactions,
       first_observed_at, first_block_number, first_log_index,
       last_observed_at, last_block_number, last_log_index, expires_at
     ) VALUES (
       'uniswap-v3', $1, $2, $3, NOW(),
       1, 1, 1, 1,
       NULL, NULL, NULL, NULL,
       0, 1, 1, 0, 1,
       NOW(), 1, 0, NOW(), 1, 0, NOW() + INTERVAL '14 days'
     )`,
    [MARKET_KEY, `0x${'b'.repeat(40)}`, `0x${'c'.repeat(40)}`]
  );
}

describe('Robinhood 1m bucket with a null FDV (stage 105)', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage65.init({ closePool: false });
    await stage66.init({ closePool: false });
    await stage78.init({ closePool: false });
    await stage105.init({ closePool: false });
    await db.query('DELETE FROM robinhood_market_buckets_1m WHERE market_key = $1', [MARKET_KEY]);
  });

  after(async () => {
    await db.query('DELETE FROM robinhood_market_buckets_1m WHERE market_key = $1', [MARKET_KEY]);
  });

  it('accepts and stores a bucket whose FDV columns are null', async () => {
    await assert.doesNotReject(insertNullFdvBucket());
    const { rows } = await db.query(
      `SELECT open_fdv_usd, high_fdv_usd, low_fdv_usd, close_fdv_usd, close_price_usd
         FROM robinhood_market_buckets_1m WHERE market_key = $1`,
      [MARKET_KEY]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].open_fdv_usd, null);
    assert.equal(rows[0].high_fdv_usd, null);
    assert.equal(rows[0].low_fdv_usd, null);
    assert.equal(rows[0].close_fdv_usd, null);
    assert.equal(rows[0].close_price_usd, '1'); // price is untouched
  });
});
