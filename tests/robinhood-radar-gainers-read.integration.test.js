process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { it, after } = require('node:test');
const { randomUUID } = require('node:crypto');
const stage268 = require('../src/utils/db-init-stage268');
const { summarizePlan } = require('../src/utils/explain-robinhood-radar-gainers');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { createRobinhoodRadarGainersReadRepository } = require('../src/models/robinhood-radar-gainers-read');
const { createRobinhoodRadarGainersPage } = require('../src/services/robinhood-radar-gainers-page');
const catalog = require('../src/models/robinhood-catalog');

const AS_OF = '2026-10-06T12:00:00.000Z';
const address = (id) => `0x${id.toString(16).padStart(40, '0')}`;
after(() => db.pool.end());

async function setup(client) {
  await client.query(`CREATE TEMP TABLE token_catalog (
    chain varchar, address varchar, symbol text, name text,
    last_image_url text, last_token_created_at_ms bigint,
    source text, first_seen_at timestamptz, last_seen_at timestamptz,
    last_price numeric, last_fdv numeric, is_active_monitor_candidate boolean,
    eligible_for_monitoring boolean, eligibility_state text, suppressed_reason text,
    monitor_priority text, last_vol_5m numeric, last_vol_1h numeric, last_vol_6h numeric,
    last_vol_24h numeric, last_liquidity_usd numeric, last_pair_address text, last_dex_id text,
    last_price_change_1h numeric, last_price_change_6h numeric, last_price_change_24h numeric,
    PRIMARY KEY(chain, address)
  ) ON COMMIT DROP`);
  await client.query(`CREATE TEMP TABLE robinhood_token_attributions (
    chain varchar, token_address varchar, source text, creator_address varchar,
    attribution_block bigint, attribution_tx_hash varchar, attribution_factory_address varchar,
    PRIMARY KEY(chain, token_address)
  ) ON COMMIT DROP`);
  await client.query(`CREATE TEMP TABLE robinhood_chain_blocks (
    chain varchar, block_number bigint, block_hash varchar, canonical boolean,
    block_timestamp timestamptz, PRIMARY KEY(chain,block_hash)
  ) ON COMMIT DROP`);
  await client.query(`CREATE UNIQUE INDEX ON robinhood_chain_blocks(chain,block_number) WHERE canonical`);
  await client.query(`CREATE TEMP TABLE robinhood_chain_transactions (
    chain varchar, block_hash varchar, transaction_hash varchar, receipt_succeeded boolean,
    to_address varchar, contract_address varchar, PRIMARY KEY(chain,block_hash,transaction_hash)
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
  await client.query(`INSERT INTO token_catalog(chain,address,symbol,name,last_token_created_at_ms)
    VALUES ($1, $2, 'GAIN', 'Gainer', $3)`,
    [options.chain ?? 'robinhood', token, options.unknownAge ? null : birth]);
  const hash = `0x${id.toString(16).padStart(64, '0')}`;
  await client.query(`INSERT INTO robinhood_token_attributions VALUES
    ('robinhood',$1,'rpc_direct',$1,$2,$3,NULL)`, [token, id, hash]);
  await client.query(`INSERT INTO robinhood_chain_blocks VALUES
    ('robinhood',$1,$2,TRUE,$3)`, [id, hash, new Date(birth)]);
  await client.query(`INSERT INTO robinhood_chain_transactions VALUES
    ('robinhood',$1,$1,TRUE,NULL,$2)`, [hash, token]);
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

it('fills only touched live tokens from canonical creation and rejects legacy ages, orphan/replayed evidence', async () => {
  await assertUsingTestDatabase(db);
  const client = await db.getClient();
  try {
    await client.query('BEGIN'); await setup(client);
    for (let id = 1; id <= 8; id += 1) await seed(client, id, { unknownAge: true });
    await client.query(`UPDATE robinhood_chain_blocks SET block_timestamp='2026-10-06 09:00+00'
      WHERE block_number=1`);
    await client.query(`UPDATE robinhood_token_attributions SET source='blockscout' WHERE token_address=$1`, [address(2)]);
    await client.query(`UPDATE robinhood_token_attributions SET attribution_tx_hash=$1 WHERE token_address=$2`,
      [`0x${'f'.repeat(64)}`, address(3)]);
    await client.query(`UPDATE robinhood_chain_transactions SET receipt_succeeded=FALSE WHERE contract_address=$1`, [address(4)]);
    await client.query(`UPDATE robinhood_chain_transactions SET contract_address=$1 WHERE contract_address=$2`, [address(999), address(8)]);
    const snapshots = [1,2,3,4,8].map((id) => ({ address: address(id), observedAt: '2026-10-06T11:59:00Z',
      priceUsd: 2, fdvUsd: 10000 }));
    const runner = { query: client.query.bind(client) };
    await catalog.applyLiveSnapshots(snapshots, runner);
    await catalog.applyLiveSnapshots(snapshots, runner); // replay preserves canonical birth
    const rows = (await client.query(`SELECT address,last_token_created_at_ms::text AS birth FROM token_catalog ORDER BY address`)).rows;
    assert.equal(rows[0].birth, String(Date.parse('2026-10-06T09:00:00Z')));
    assert.ok(rows.slice(1).every((row) => row.birth === null)); // no sweep/backfill
    const reader = createRobinhoodRadarGainersReadRepository({ database: {
      queryWithStatementTimeout: (sql, params) => client.query(sql, params),
    } });
    assert.deepEqual((await reader.getGainers({ asOf: AS_OF })).items.map((row) => row.identity.address), [address(1)]);
    await client.query(`UPDATE token_catalog SET last_token_created_at_ms=$1 WHERE address=$2`,
      [Date.parse('2026-10-06T11:05:00Z'), address(5)]); // plausible pool age is not proof
    assert.equal((await reader.getGainers({ asOf: AS_OF })).candidateCount, 1);
    await client.query(`UPDATE robinhood_chain_blocks SET canonical=FALSE WHERE block_number=1`);
    assert.equal((await reader.getGainers({ asOf: AS_OF })).candidateCount, 0);
    await client.query(`INSERT INTO robinhood_chain_blocks VALUES
      ('robinhood',1,$1,TRUE,'2026-10-06 10:00+00')`, [`0x${'e'.repeat(64)}`]);
    assert.equal((await reader.getGainers({ asOf: AS_OF })).candidateCount, 0); // reused height, wrong tx/hash
    await client.query(`UPDATE robinhood_chain_blocks SET canonical=FALSE WHERE block_hash=$1`, [`0x${'e'.repeat(64)}`]);
    await client.query(`UPDATE robinhood_chain_blocks SET canonical=TRUE WHERE block_number=1 AND block_hash<>$1`, [`0x${'e'.repeat(64)}`]);
    const snapshot = { tokenAddress: address(1), protocol: 'uniswap-v3', marketKey: `robinhood:uniswap-v3:${address(99)}`,
      discoveredAt: '2026-10-06T11:05:00Z', lastObservedAt: '2026-10-06T11:59:00Z', lastPriceUsd: '2', lastFdvUsd: '10000' };
    await catalog.projectDashboardSnapshot(snapshot, runner);
    assert.equal((await reader.getGainers({ asOf: AS_OF })).items[0].createdAt, Date.parse('2026-10-06T09:00:00Z'));
    await catalog.projectDashboardSnapshot({ ...snapshot, tokenAddress: address(2) }, runner);
    assert.equal((await client.query('SELECT last_token_created_at_ms FROM token_catalog WHERE address=$1', [address(2)])).rows[0].last_token_created_at_ms, null);
    await client.query(`UPDATE robinhood_token_attributions SET source='rpc_trace', attribution_factory_address=$1 WHERE token_address=$2`, [address(99), address(6)]);
    await client.query(`UPDATE robinhood_chain_transactions SET contract_address=NULL,to_address=$1 WHERE contract_address=$2`, [address(99), address(6)]);
    await catalog.projectDashboardSnapshot({ ...snapshot, tokenAddress: address(6) }, runner);
    assert.equal((await client.query('SELECT last_token_created_at_ms::text AS birth FROM token_catalog WHERE address=$1', [address(6)])).rows[0].birth,
      String(Date.parse('2026-10-06T11:00:00Z')));
  } finally { await client.query('ROLLBACK'); client.release(); }
});

it('accepts the partitioned transaction layout with pruning and without changing canonical birth', async () => {
  await assertUsingTestDatabase(db);
  const client = await db.getClient();
  try {
    await client.query('BEGIN'); await setup(client);
    await seed(client, 1);
    await client.query('ALTER TABLE pg_temp.robinhood_chain_transactions RENAME TO birth_transactions_old');
    await client.query(`CREATE TEMP TABLE robinhood_chain_transactions (
      chain varchar, block_hash varchar, transaction_hash varchar, receipt_succeeded boolean,
      to_address varchar, contract_address varchar, block_number bigint,
      PRIMARY KEY(chain,block_number,block_hash,transaction_hash)
    ) PARTITION BY RANGE(block_number)`);
    for (let start = 0; start < 10000; start += 1000) {
      await client.query(`CREATE TEMP TABLE birth_tx_${start} PARTITION OF robinhood_chain_transactions
        FOR VALUES FROM (${start}) TO (${start+1000})`);
    }
    await client.query(`INSERT INTO robinhood_chain_transactions SELECT transaction.*,block.block_number
      FROM birth_transactions_old transaction JOIN robinhood_chain_blocks block USING(chain,block_hash)`);
    let plan;
    const reader = createRobinhoodRadarGainersReadRepository({ database: {
      async queryWithStatementTimeout(sql, params) {
        if (sql.startsWith('SELECT relation.relkind')) return client.query(sql, params);
        plan = summarizePlan((await client.query('EXPLAIN (ANALYZE, FORMAT JSON) '+sql, params)).rows[0]['QUERY PLAN'][0]);
        return client.query(sql, params);
      },
    } });
    const page = await reader.getGainers({ asOf: AS_OF });
    assert.equal(page.items[0].createdAt, Date.parse('2026-10-06T11:00:00Z'));
    const active = plan.scans.filter((scan) => scan.table.startsWith('birth_tx_') && scan.loops > 0);
    assert.equal(active.length, 1);
    assert.equal(active[0].table, 'birth_tx_0');
    assert.equal(active[0].loops, 1);
  } finally { await client.query('ROLLBACK'); client.release(); }
});

it('reads a committed intra-minute price immediately while preserving historical cutoff behavior', async () => {
  await assertUsingTestDatabase(db);
  const client = await db.getClient();
  try {
    await client.query('BEGIN'); await setup(client); await seed(client, 1);
    await client.query(`INSERT INTO robinhood_market_buckets_agg VALUES
      ('robinhood',$1,5,1,'2026-10-06 12:00+00','2026-10-06 12:00:20+00','uniswap-v3','primary')`, [address(1)]);
    await client.query(`INSERT INTO robinhood_market_buckets_1m VALUES
      ('robinhood',$1,'uniswap-v3','primary','2026-10-06 12:00+00',
       '2026-10-06 12:00:20+00','2026-10-06 12:00:20+00',3,0,3,0,3,3,10000)`, [address(1)]);
    const reader = createRobinhoodRadarGainersReadRepository({ database: {
      queryWithStatementTimeout: (sql, params) => client.query(sql, params),
    } });
    const input = { asOf: '2026-10-06T12:00:45.123Z', live: true };
    const latest = await reader.getGainers(input);
    assert.equal(latest.asOf, input.asOf); assert.equal(latest.items[0].priceUsd, '3');
    assert.equal(Number(latest.items[0].priceChangePct), 200);
    assert.equal((await reader.getGainers({ ...input, asOf: '2026-10-06T12:00:19Z' })).items[0].priceUsd, '2');
    assert.equal((await reader.getGainers({ asOf: input.asOf })).items[0].priceUsd, '2');
  } finally { await client.query('ROLLBACK'); client.release(); }
});

it('applies persisted user/global blocks and dismissals before selecting the personalized top', async () => {
  await assertUsingTestDatabase(db);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await setup(client);
    await client.query(`CREATE TEMP TABLE user_blocklist
      (user_id int, chain varchar, address varchar) ON COMMIT DROP`);
    for (let id = 1; id <= 4; id += 1) await seed(client, id, { current: 10 - id });
    await client.query(`INSERT INTO user_blocklist VALUES
      (22, 'robinhood', $1), (42, 'robinhood', $2), (22, 'base', $3)`,
    [address(1), address(2), address(4)]);
    await client.query(`INSERT INTO admin_blocked_tokens VALUES ('robinhood', $1)`, [address(3)]);
    let time = Date.parse(AS_OF) + 45000;
    const database = { queryWithStatementTimeout: (sql, params) => client.query(sql, params) };
    const page = createRobinhoodRadarGainersPage({ database, now: () => time,
      service: createRobinhoodRadarGainersReadRepository({ database }) });
    const first = await page.list(22, { dismissedIdentities: [`robinhood:${address(4)}`] });
    assert.deepEqual(first.items.map((item) => item.identity.address), [address(2)]);
    time += 5000;
    const second = await page.list(42);
    assert.deepEqual(second.items.map((item) => item.identity.address), [address(1), address(4)]);
    await client.query(`INSERT INTO user_blocklist VALUES (22, 'robinhood', $1)`, [address(2)]);
    time += 5000;
    const changed = await page.list(22);
    assert.deepEqual(changed.items.map((item) => item.identity.address), [address(4)]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

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
    await client.query(`INSERT INTO robinhood_market_buckets_agg VALUES
      ('robinhood', $1, 5, 1, '2026-10-06 12:00+00', '2026-10-06 12:01+00', 'uniswap-v2', 'future'),
      ('robinhood', $2, 5, 1, '2026-10-06 11:50+00', '2026-10-06 11:54+00', 'uniswap-v3', 'primary')`,
    [address(25), address(35)]);
    await client.query(`INSERT INTO robinhood_market_buckets_1m VALUES
      ('robinhood', $1, 'uniswap-v3', 'primary', '2026-10-06 11:58+00',
       '2026-10-06 11:58+00', '2026-10-06 11:58+00', 2, 0, 2, 0, 999, 999, 10000)`, [address(35)]);
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
  }
});

it('measures an indexed candidate universe with realistic market density without changing winners', async (t) => {
  await assertUsingTestDatabase(db);
  const client = await db.getClient();
  try {
    await client.query('BEGIN'); await setup(client);
    await client.query("SET LOCAL statement_timeout='30s'");
    await client.query('SET LOCAL jit=off');
    // Bound fixture loading separately from the unchanged 5s ranking budget.
    for (let start = 10000; start < 510000; start += 50000) {
      await client.query(`INSERT INTO token_catalog(chain,address,symbol,name,last_image_url,last_token_created_at_ms)
        SELECT 'robinhood', '0x'||lpad(to_hex(id),40,'0'), 'OLD', NULL, NULL, 1700000000000
        FROM generate_series($1::int,$2::int) id`, [start, start + 49999]);
    }
    for (let id = 1; id <= 100; id += 1) await seed(client, id, { ageHours: 12, current: id + 1 });
    await client.query(`INSERT INTO robinhood_market_buckets_1m
      SELECT chain, token_address, protocol, market_key, bucket_ts - n*INTERVAL '1 minute',
        first_observed_at - n*INTERVAL '1 minute', last_observed_at - n*INTERVAL '1 minute',
        1, 0, 1, 0, 1, 1, 10000
      FROM robinhood_market_buckets_1m CROSS JOIN generate_series(1,720) n
      WHERE last_block_number=2`);
    // The production planner can prefer the global time index even with a token index.
    // Exercise that access path with unrelated recent markets and mostly unpriced candidates.
    await client.query(`INSERT INTO robinhood_market_buckets_agg
      SELECT 'robinhood', '0x'||lpad(to_hex(id),40,'0'), 5, 1,
        '2026-10-06 11:55+00', '2026-10-06 11:59+00', 'uniswap-v3', 'unrelated'
      FROM generate_series(10000,24999) id`);
    await client.query(`UPDATE robinhood_market_buckets_agg
      SET bucket_ts='2026-10-06 11:40+00', last_observed_at='2026-10-06 11:44+00'
      WHERE token_address=ANY($1::varchar[])`,
    [Array.from({ length: 100 }, (_, i) => i + 1).filter((id) => id % 5).map(address)]);
    await client.query(`CREATE INDEX gainers_fixture_agg_cleanup
      ON robinhood_market_buckets_agg(granularity_minutes, bucket_ts)`);
    for (const table of ['token_catalog','robinhood_market_buckets_1m','robinhood_market_buckets_agg']) {
      await client.query(`ANALYZE ${table}`);
    }
    await client.query("SET LOCAL statement_timeout='5s'");
    let measured;
    const reader = createRobinhoodRadarGainersReadRepository({ database: {
      async queryWithStatementTimeout(sql, params) {
        if (sql.startsWith('SELECT relation.relkind')) return client.query(sql, params);
        measured = summarizePlan((await client.query(
          `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${sql}`, params
        )).rows[0]['QUERY PLAN'][0]);
        return client.query(sql, params);
      },
    } });
    const before = await reader.getGainers({ asOf: AS_OF });
    const baseline = measured;
    await client.query(stage268.STATEMENTS[0].replace('CONCURRENTLY ', ''));
    const indexed = await reader.getGainers({ asOf: AS_OF });
    assert.deepEqual(indexed, before);
    assert.equal(indexed.candidateCount, 100);
    assert.ok(measured.scans.some((scan) => scan.index === stage268.INDEX_NAME));
    assert.ok(!measured.scans.some((scan) => scan.table === 'token_catalog' && scan.type === 'Seq Scan'));
    // Keep the global path as the only aggregate index for a deterministic regression.
    const tokenIndex = (await client.query(`SELECT indexrelid::regclass::text AS name FROM pg_index
      WHERE indrelid='pg_temp.robinhood_market_buckets_agg'::regclass
        AND pg_get_indexdef(indexrelid) LIKE '%chain, token_address, granularity_minutes%'`)).rows[0].name;
    await client.query(`DROP INDEX ${tokenIndex}`);
    const globalPath = await reader.getGainers({ asOf: AS_OF });
    assert.deepEqual(globalPath, indexed);
    assert.equal(globalPath.unpricedCount, 80);
    const aggregateScans = measured.scans.filter((scan) => scan.table === 'robinhood_market_buckets_agg');
    const examined = aggregateScans.reduce((sum, scan) => sum + (scan.rows + scan.removed) * scan.loops, 0);
    assert.ok(examined <= 15100 * 2, `aggregate work must not multiply by candidates: ${examined} rows`);
    t.diagnostic(JSON.stringify({ fixture: { catalog: 500100, candidates: 100, minuteBuckets: 72200 },
      baseline, indexed: measured, limitation: 'local temporary fixture; no production speedup established' }));
  } finally { await client.query('ROLLBACK'); client.release(); }
});

it('builds the concurrent migration idempotently in an isolated test schema and rejects an invalid index', async () => {
  await assertUsingTestDatabase(db);
  const client = await db.getClient();
  const schema = `radar_gainers_${randomUUID().replaceAll('-', '')}`;
  try {
    await client.query(`CREATE SCHEMA ${schema}`); await client.query(`SET search_path TO ${schema}`);
    await client.query('CREATE TABLE token_catalog(chain varchar, address varchar, last_token_created_at_ms bigint)');
    const options = { closePool: false, database: { async getClient() {
      return { query: client.query.bind(client), release() {} };
    } } };
    await stage268.init(options); await stage268.init(options);
    const { rows } = await client.query(`SELECT pg_get_indexdef(indexrelid) AS definition FROM pg_index
      WHERE indexrelid=to_regclass($1)`, [stage268.INDEX_NAME]);
    assert.match(rows[0].definition, /last_token_created_at_ms, address/);
    assert.match(rows[0].definition, /robinhood.*last_token_created_at_ms > 0/);
    await client.query(`DROP INDEX ${stage268.INDEX_NAME}`);
    await client.query(`INSERT INTO token_catalog VALUES ('robinhood','duplicate',1),('robinhood','duplicate',1)`);
    await assert.rejects(client.query(`CREATE UNIQUE INDEX CONCURRENTLY ${stage268.INDEX_NAME}
      ON token_catalog(address)`), { code: '23505' });
    await assert.rejects(stage268.init(options), /is invalid/);
  } finally {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); client.release();
  }
});
