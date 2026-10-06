process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { createRobinhoodRadarGainersReadRepository } = require('../src/models/robinhood-radar-gainers-read');

const AS_OF = '2026-10-06T12:00:00.000Z';
const address = (id) => `0x${id.toString(16).padStart(40, '0')}`;

async function setup(client) {
  await client.query(`CREATE TEMP TABLE token_catalog (
    chain varchar, address varchar, symbol text, name text,
    last_image_url text, last_token_created_at_ms bigint
  ) ON COMMIT DROP`);
  await client.query(`CREATE TEMP TABLE admin_blocked_tokens (chain varchar, address varchar) ON COMMIT DROP`);
  await client.query(`CREATE TEMP TABLE robinhood_market_buckets_agg (
    chain varchar, token_address varchar, granularity_minutes int,
    source_granularity_minutes int, bucket_ts timestamptz, last_observed_at timestamptz,
    valuation_protocol text, valuation_market_key text
  ) ON COMMIT DROP`);
  await client.query(`CREATE TEMP TABLE robinhood_market_buckets_1m (
    chain varchar, token_address varchar, protocol text, market_key text,
    bucket_ts timestamptz, first_observed_at timestamptz, last_observed_at timestamptz,
    first_block_number bigint, first_log_index bigint, last_block_number bigint,
    last_log_index bigint, open_price_usd numeric, close_price_usd numeric, close_fdv_usd numeric
  ) ON COMMIT DROP`);
  await client.query(`CREATE INDEX ON robinhood_market_buckets_1m
    (chain, token_address, bucket_ts DESC)`);
  await client.query(`CREATE INDEX ON robinhood_market_buckets_agg
    (chain, token_address, granularity_minutes, bucket_ts DESC)`);
}

async function seed(client, id, options = {}) {
  const token = address(id);
  const birth = Date.parse(AS_OF) - (options.ageHours ?? 1) * 3600000;
  const baseline = new Date(birth + 60000);
  const current = new Date(Date.parse(AS_OF) - (options.currentMinutes ?? (options.stale ? 16 : 1)) * 60000);
  const market = options.changedMarket ? 'other' : 'primary';
  await client.query(`INSERT INTO token_catalog VALUES ($1, $2, 'GAIN', 'Gainer', NULL, $3)`,
    [options.chain ?? 'robinhood', token, options.unknownAge ? null : birth]);
  await client.query(`INSERT INTO robinhood_market_buckets_agg VALUES
    ('robinhood', $1, 5, 1, date_bin('5 minutes', $2::timestamptz, '1970-01-01'::timestamptz),
     $2, 'uniswap-v3', $3)`,
  [token, current, market]);
  if (options.base !== null) {
    await client.query(`INSERT INTO robinhood_market_buckets_1m VALUES
      ('robinhood', $1, 'uniswap-v3', 'primary', date_trunc('minute', $2::timestamptz),
       $2, $2, 1, 0, 1, 0, $3, $3, 10000)`, [token, baseline, options.base ?? 1]);
  }
  await client.query(`INSERT INTO robinhood_market_buckets_1m VALUES
    ('robinhood', $1, 'uniswap-v3', $2, date_trunc('minute', $3::timestamptz),
     $3, $3, 2, 0, 2, 0, $4, $4, $5)`,
  [token, market, current, options.current ?? 2, options.fdv ?? 10000]);
  return token;
}

it('selects global young-token gainers with comparable first prices, exclusions and stable ties', async (t) => {
  await assertUsingTestDatabase(db);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await setup(client);
    const reader = createRobinhoodRadarGainersReadRepository({
      database: { queryWithStatementTimeout(sql, params, timeoutMs) {
        assert.equal(timeoutMs, 5000);
        return client.query(sql, params);
      } },
    });
    // More candidates than the maximum returned list; the best lies beyond it.
    for (let id = 1; id <= 25; id += 1) await seed(client, id, { current: id + 1 });
    await seed(client, 26, { current: 26 }); // equal gain, address breaks the tie
    await seed(client, 27, { ageHours: 24, current: 40 });
    for (const [id, options] of [
      [28, { ageHours: 24.001 }], [29, { ageHours: -1 }], [30, { unknownAge: true }],
      [31, { chain: 'solana' }], [32, { stale: true }], [33, { base: null }],
      [34, { base: 0 }], [35, { changedMarket: true }], [36, { current: 0 }],
      [37, { current: 'NaN' }], [38, { fdv: 30000000000 }], [39, { current: 0.5 }],
    ]) await seed(client, id, options);
    const blocked = await seed(client, 40, { current: 500 });
    await client.query('INSERT INTO admin_blocked_tokens VALUES ($1, $2)', ['robinhood', blocked]);
    const excluded = await seed(client, 41, { current: 600 });
    // Future observations and a different pool cannot replace the selected price.
    await client.query(`INSERT INTO robinhood_market_buckets_1m VALUES
      ('robinhood', $1, 'uniswap-v3', 'primary', '2026-10-06 12:01+00',
       '2026-10-06 12:01+00', '2026-10-06 12:01+00', 3, 0, 3, 0, 999, 999, 10000),
      ('robinhood', $1, 'uniswap-v2', 'other', '2026-10-06 11:59+00',
       '2026-10-06 11:59+00', '2026-10-06 11:59+00', 2, 1, 2, 1, 999, 999, 10000)`,
    [address(25)]);
    const page = await reader.getGainers({ asOf: AS_OF, limit: 3,
      excludedAddresses: [excluded, excluded.toUpperCase()] });
    assert.equal(page.total, 27);
    assert.equal(page.hasMore, true);
    assert.equal(page.candidateCount, 34);
    assert.equal(page.unpricedCount, 4);
    assert.deepEqual(page.items.map((item) => item.identity.address), [address(27), address(25), address(26)]);
    assert.deepEqual(page.items.map((item) => Number(item.priceChangePct)), [3900, 2500, 2500]);
    assert.equal(page.items[1].priceUsd, '26');
    assert.equal(page.items[1].priceBasis.priceUsd, '1');
    assert.equal(page.items[1].priceBasis.type, 'first-observed-price');
    assert.equal(page.items[1].priceBasis.coverage, 'available-history');
    assert.equal(page.items[1].priceBasis.observedAt, '2026-10-06T11:01:00.000Z');
    assert.equal((await reader.getGainers({ asOf: AS_OF })).items.length, 15);
    // An earlier cutoff must not use mutable buckets containing later observations.
    const earlier = await reader.getGainers({ asOf: '2026-10-06T11:30:00.000Z' });
    assert.equal(earlier.items.length, 0);
    // A fresh observation can live in a five-minute aggregate starting before the freshness cutoff.
    const boundary = await seed(client, 42, { currentMinutes: 11, current: 2000 });
    const fresh = await reader.getGainers({ asOf: '2026-10-06T12:03:45.000Z', limit: 1 });
    assert.equal(fresh.asOf, '2026-10-06T12:03:00.000Z');
    assert.equal(fresh.items[0].identity.address, boundary);
    // A first-price bucket that includes future observations cannot supply a historical baseline.
    await client.query(`UPDATE robinhood_market_buckets_1m SET last_observed_at = '2026-10-06 12:04+00'
      WHERE token_address = $1 AND first_block_number = 1`, [boundary]);
    const mutable = await reader.getGainers({ asOf: '2026-10-06T12:03:00.000Z' });
    assert.equal(mutable.items.some((item) => item.identity.address === boundary), false);
    // Empty and unpriced universes remain distinguishable without fabricated zeros.
    await client.query('DELETE FROM robinhood_market_buckets_agg');
    const unpriced = await reader.getGainers({ asOf: AS_OF });
    assert.equal(unpriced.total, 0);
    assert.equal(unpriced.unpricedCount, unpriced.candidateCount);
    await client.query('DELETE FROM token_catalog');
    assert.deepEqual(await reader.getGainers({ asOf: AS_OF }), {
      chain: 'robinhood', asOf: AS_OF, limit: 15,
      candidateCount: 0, unpricedCount: 0, total: 0, hasMore: false, items: [],
    });
    t.diagnostic('SQL selection uses temporary fixtures; production query cost is not established.');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await db.pool.end();
  }
});
