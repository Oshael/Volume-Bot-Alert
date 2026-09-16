process.env.NODE_ENV = 'test';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { createDashboardRadarReader } = require('../src/services/dashboard-radar-reader');
const { createRobinhoodWorkspaceRadarReader } = require('../src/services/robinhood-workspace-radar-reader');

it('unified radar SQL filters and paginates mixed ages and excludes blocked pins', async () => {
  let client;
  try {
    await assertUsingTestDatabase(db);
    client = await db.getClient();
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE token_catalog (
      chain text, address text, symbol text, name text, source text,
      first_seen_at timestamptz, last_seen_at timestamptz, last_evaluated_at timestamptz,
      last_token_created_at_ms bigint, last_fdv numeric, last_price numeric,
      last_liquidity_usd numeric, last_pair_address text, last_pair_url text,
      last_dex_id text, last_image_url text, launchpad_id text,
      last_twitter_url text, last_community_url text, monitor_priority text
    ) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE admin_blocked_tokens (chain text, address text) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE robinhood_market_buckets_1h (
      chain text, token_address text, protocol text, market_key text,
      bucket_ts timestamptz, last_observed_at timestamptz,
      last_block_number bigint, last_log_index bigint, close_fdv_usd numeric
    ) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE robinhood_published_holder_summaries (
      chain text, token_address text, holder_count bigint, source text,
      observed_at timestamptz, checked_at timestamptz
    ) ON COMMIT DROP`);
    const addresses = [1, 2, 3, 4].map((n) => `0x${String(n).repeat(40)}`);
    const asOf = '2026-07-15T18:00:00.000Z';
    for (const [index, address] of addresses.entries()) {
      await client.query(`INSERT INTO token_catalog (chain, address, symbol, first_seen_at)
        VALUES ('robinhood', $1, 'RADAR', $2)`,
      [address, new Date(Date.parse(asOf) - [1, 14, 7, 30][index] * 86_400_000)]);
    }
    await client.query('INSERT INTO admin_blocked_tokens VALUES ($1, $2)', ['robinhood', addresses[3]]);
    const reader = createDashboardRadarReader({
      robinhoodReader: createRobinhoodWorkspaceRadarReader({
        database: client,
        windowRead: { async getMetricsByAddresses({ addresses: requested }) {
          return requested.map((address) => ({ address, chain: 'robinhood', lastActivityAt: null }));
        } },
      }),
      solanaReader: { async listRadarPrefix() { assert.fail('unexpected Solana read'); } },
    });
    const input = { bucket: 'all', asOf, chains: ['robinhood'], minFdv: 0, perPage: 2,
      sorts: [{ mode: 'age', window: 'newest' }], searchQuery: 'radar' };
    const first = await reader.listExactRadar(input);
    const second = await reader.listExactRadar({ ...input, page: 1 });
    assert.equal(first.total, 3);
    assert.equal(first.hasMore, true);
    assert.equal(second.hasMore, false);
    assert.deepEqual([...first.rows, ...second.rows].map((r) => r.identity.address),
      [addresses[0], addresses[2], addresses[1]]);
    const filtered = await reader.listExactRadar({ ...input, ageMaxMinutes: 10_080,
      dismissedIdentities: [`robinhood:${addresses[0]}`] });
    assert.deepEqual(filtered.rows.map((r) => r.identity.address), [addresses[2]]);
    const starred = await reader.listExactRadar({ ...input, starredOnly: true,
      starredIdentities: [`robinhood:${addresses[1]}`] });
    assert.deepEqual(starred.rows.map((r) => r.identity.address), [addresses[1]]);
    const pins = await reader.listRadarPins({ ...input,
      pinnedIdentities: addresses.map((a) => `robinhood:${a}`),
      excludedIdentities: [`robinhood:${addresses[1]}`], pageRows: filtered.rows });
    assert.deepEqual(pins.map((r) => r.identity.address), [addresses[0]]);
  } finally {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    await db.pool.end();
  }
});
