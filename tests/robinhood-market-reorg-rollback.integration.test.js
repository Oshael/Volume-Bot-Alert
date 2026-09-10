process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');

const db = require('../src/models/db');
const { createRobinhoodMarketReorgRollback } = require(
  '../src/models/robinhood-market-reorg-rollback'
);
const { createRobinhoodMarketAggregateRepository } = require(
  '../src/models/robinhood-market-aggregate'
);
const stage63 = require('../src/utils/db-init-stage63');
const stage64 = require('../src/utils/db-init-stage64');
const stage65 = require('../src/utils/db-init-stage65');
const stage66 = require('../src/utils/db-init-stage66');
const stage67 = require('../src/utils/db-init-stage67');
const stage68 = require('../src/utils/db-init-stage68');
const stage78 = require('../src/utils/db-init-stage78');
const stage79 = require('../src/utils/db-init-stage79');
const stage96 = require('../src/utils/db-init-stage96');
const stage104 = require('../src/utils/db-init-stage104');
const stage105 = require('../src/utils/db-init-stage105');
const stage106 = require('../src/utils/db-init-stage106');
const stage191 = require('../src/utils/db-init-stage191');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const BLOCK = 912345678;
const BLOCK_HASH = `0x${'a'.repeat(64)}`;
const ORPHAN_HASH = `0x${'b'.repeat(64)}`;
const PARENT_HASH = `0x${'c'.repeat(64)}`;
const TX = `0x${'d'.repeat(64)}`;
const ORPHAN_TX = `0x${'e'.repeat(64)}`;
const TOPIC = `0x${'f'.repeat(64)}`;
const TOKEN = `0x${'1'.repeat(40)}`;
const QUOTE = `0x${'2'.repeat(40)}`;
const MARKET = `robinhood:uniswap-v2:0x${'3'.repeat(40)}`;
const MINUTE = '2026-09-10T08:00:00.000Z';

async function clear() {
  await db.query('DELETE FROM robinhood_derived_outbox WHERE market_key=$1', [MARKET]);
  await db.query('DELETE FROM robinhood_market_buckets_agg WHERE token_address=$1', [TOKEN]);
  await db.query('DELETE FROM robinhood_market_buckets_1h WHERE market_key=$1', [MARKET]);
  await db.query('DELETE FROM robinhood_market_buckets_1m WHERE market_key=$1', [MARKET]);
  await db.query('DELETE FROM robinhood_processed_logs WHERE transaction_hash IN ($1,$2)', [TX, ORPHAN_TX]);
  await db.query(
    'DELETE FROM robinhood_chain_blocks WHERE block_number BETWEEN $1 AND $2',
    [BLOCK, BLOCK + 1]
  );
}

async function seed() {
  await db.query(
    `INSERT INTO robinhood_chain_blocks(
       chain, block_number, block_hash, parent_hash, capture_digest, block_timestamp,
       finality, canonical, head_observed_at, receipts_available_at
     ) VALUES
       ('robinhood',$1,$2,$3,$2,$4,'observed',TRUE,$4,$4),
       ('robinhood',$5,$6,$2,$6,$4,'observed',TRUE,$4,$4)`,
    [BLOCK, BLOCK_HASH, PARENT_HASH, MINUTE, BLOCK + 1, ORPHAN_HASH]
  );
  await db.query(
    `INSERT INTO robinhood_processed_logs(
       chain, transaction_hash, log_index, stream, block_number, block_hash,
       topic0, event_kind, protocol, market_key
     ) VALUES
       ('robinhood',$1,0,'market',$2,$3,$4,'swap','uniswap-v2',$5),
       ('robinhood',$6,1,'market',$7,$8,$4,'swap','uniswap-v2',$5)`,
    [TX, BLOCK, BLOCK_HASH, TOPIC, MARKET, ORPHAN_TX, BLOCK + 1, ORPHAN_HASH]
  );
  await db.query(
    `INSERT INTO robinhood_market_observations(
       chain, transaction_hash, log_index, block_number, protocol, market_key,
       pool_address, token_address, quote_address, side, status, observed_at,
       token_decimals, quote_decimals, token_total_supply_raw, token_supply_status,
       token_supply_anchor_block_number, token_amount_raw, quote_amount_raw,
       token_amount, quote_amount, price_quote, quote_usd_price, price_usd,
       volume_usd, fdv_usd, market_cap_usd, valuation_type, quote_usd_source,
       quote_usd_status, liquidity_usd, liquidity_status, liquidity_confidence
     ) VALUES
       ('robinhood',$1,0,$2,'uniswap-v2',$3,$4,$5,$6,'buy','accepted',$7,
        18,18,1000,'latest_call',$2,1,1,1,1,1,1,1,10,1000,1000,'fdv','test','ready',
        100,'spot_estimate_from_double_quote_reserve','medium'),
       ('robinhood',$8,1,$9,'uniswap-v2',$3,$4,$5,$6,'sell','accepted',
        $7::timestamptz + INTERVAL '20 seconds',18,18,1000,'latest_call',$9,
        1,1,1,1,2,1,2,20,2000,2000,'fdv','test','ready',
        200,'spot_estimate_from_double_quote_reserve','medium')`,
    [TX, BLOCK, MARKET, MARKET.split(':').at(-1), TOKEN, QUOTE, MINUTE, ORPHAN_TX, BLOCK + 1]
  );
  await db.query(
    `INSERT INTO robinhood_market_buckets_1m(
       chain, protocol, market_key, token_address, quote_address, bucket_ts,
       open_price_usd, high_price_usd, low_price_usd, close_price_usd,
       open_fdv_usd, high_fdv_usd, low_fdv_usd, close_fdv_usd,
       close_liquidity_usd, close_liquidity_status, close_liquidity_confidence,
       volume_usd, swaps, buys, sells, transactions, first_observed_at,
       first_block_number, first_log_index, last_observed_at, last_block_number,
       last_log_index, expires_at
     ) VALUES ('robinhood','uniswap-v2',$1,$2,$3,$4,1,2,1,2,1000,2000,1000,2000,
       200,'spot_estimate_from_double_quote_reserve','medium',30,2,1,1,2,$4,$5,0,
       $4::timestamptz + INTERVAL '20 seconds',$6,1,$4::timestamptz + INTERVAL '14 days')`,
    [MARKET, TOKEN, QUOTE, MINUTE, BLOCK, BLOCK + 1]
  );
  await db.query(
    `INSERT INTO robinhood_derived_outbox(
       chain, protocol, market_key, token_address, bucket_ts,
       last_block_number, last_log_index, payload
     ) VALUES ('robinhood','uniswap-v2',$1,$2,$3,$4,1,'{}')`,
    [MARKET, TOKEN, MINUTE, BLOCK + 1]
  );
}

describe('Robinhood market reorg rollback', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    for (const stage of [stage63, stage64, stage65, stage66, stage67, stage68,
      stage78, stage79, stage96, stage104, stage105, stage106, stage191]) {
      await stage.init({ closePool: false });
    }
  });
  beforeEach(async () => { await clear(); await seed(); });
  after(async () => { await clear().catch(() => {}); await db.pool.end().catch(() => {}); });

  it('removes only orphan evidence and exactly rebuilds every market tier', async () => {
    const client = await db.getClient();
    let summary;
    try {
      await client.query('BEGIN');
      summary = await createRobinhoodMarketReorgRollback().rollback(client, {
        fromBlock: BLOCK + 1, throughBlock: BLOCK + 1,
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {}); throw error;
    } finally { client.release(); }

    assert.equal(summary.affectedTokens, 1);
    assert.equal(summary.deletedProcessedLogs, 1);
    assert.equal(summary.deletedDerivedRows, 1);
    assert.equal(summary.deletedMinuteBuckets, 1);
    assert.equal(summary.rebuiltMinuteBuckets, 1);
    const rows = await db.query(
      `SELECT
         (SELECT COUNT(*)::int FROM robinhood_market_observations
           WHERE market_key=$1) AS observations,
         (SELECT COUNT(*)::int FROM robinhood_processed_logs
           WHERE transaction_hash=$2) AS orphan_logs,
         (SELECT volume_usd::text FROM robinhood_market_buckets_1m
           WHERE market_key=$1) AS minute_volume,
         (SELECT volume_usd::text FROM robinhood_market_buckets_1h
           WHERE market_key=$1) AS hour_volume,
         (SELECT volume_usd::text FROM robinhood_market_buckets_agg
           WHERE token_address=$3 AND granularity_minutes=5) AS aggregate_volume,
         (SELECT COUNT(*)::int FROM robinhood_derived_outbox
           WHERE market_key=$1) AS derived_rows`,
      [MARKET, ORPHAN_TX, TOKEN]
    );
    assert.deepEqual(rows.rows[0], {
      observations: 1, orphan_logs: 0, minute_volume: '10', hour_volume: '10',
      aggregate_volume: '10', derived_rows: 0,
    });
  });

  it('removes an empty bucket instead of materializing zero market data', async () => {
    const aggregate = createRobinhoodMarketAggregateRepository();
    await aggregate.refreshHourlyRange({
      from: MINUTE, to: '2026-09-10T09:00:00.000Z', tokenAddress: TOKEN,
      afterToken: null, tokenLimit: 1,
    });
    await aggregate.refreshAggregateRange({
      from: MINUTE, to: '2026-09-10T09:00:00.000Z', granularities: [5, 15, 30],
      tokenAddress: TOKEN, afterToken: null, tokenLimit: 1,
    });
    await aggregate.refreshAggregateRange({
      from: MINUTE, to: '2026-09-10T09:00:00.000Z', granularities: [60, 240, 1440],
      tokenAddress: TOKEN, afterToken: null, tokenLimit: 1,
    });
    await db.query('DELETE FROM robinhood_processed_logs WHERE transaction_hash=$1', [TX]);
    await db.query(
      `UPDATE robinhood_market_buckets_1m
          SET open_price_usd=2, high_price_usd=2, low_price_usd=2, close_price_usd=2,
              open_fdv_usd=2000, high_fdv_usd=2000, low_fdv_usd=2000,
              close_fdv_usd=2000, volume_usd=20, swaps=1, buys=0, sells=1,
              transactions=1, first_observed_at=$2::timestamptz + INTERVAL '20 seconds',
              first_block_number=$3, first_log_index=1
        WHERE market_key=$1`, [MARKET, MINUTE, BLOCK + 1]
    );
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await createRobinhoodMarketReorgRollback().rollback(client, {
        fromBlock: BLOCK + 1, throughBlock: BLOCK + 1,
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {}); throw error;
    } finally { client.release(); }
    const result = await db.query(
      `SELECT
         (SELECT COUNT(*)::int FROM robinhood_market_buckets_1m
           WHERE market_key=$1) AS minute_buckets,
         (SELECT COUNT(*)::int FROM robinhood_market_buckets_1h
           WHERE market_key=$1) AS hour_buckets,
         (SELECT COUNT(*)::int FROM robinhood_market_buckets_agg
           WHERE token_address=$2) AS aggregate_buckets`, [MARKET, TOKEN]
    );
    assert.deepEqual(result.rows[0], {
      minute_buckets: 0, hour_buckets: 0, aggregate_buckets: 0,
    });
  });
});
