const assert = require('node:assert/strict');
const { it } = require('node:test');
const stage178 = require('../src/utils/db-init-stage178');
const stage179 = require('../src/utils/db-init-stage179');
const stage185 = require('../src/utils/db-init-stage185');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

it('registers a frozen 14-day FRESH activation and event-driven work queue', () => {
  const sql = stage178.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage178-robinhood-fresh-wallet-foundation'
  ));
  assert.match(sql, /seed_cutoff_at = activation_at - INTERVAL '14 days'/);
  assert.match(sql, /FRESH activation boundary is immutable/);
  assert.match(sql, /FRESH seed cohort is immutable/);
  assert.match(sql, /NEW\.block_number > activation\.activation_block/);
  assert.match(sql, /source_kind = 'live' AND seed_run_id IS NULL/);
  assert.match(sql, /coverage_scope IN \('seed', 'live', 'partial'\)/);
  assert.match(sql, /status <> 'ready'.*coverage_scope <> 'partial'/s);
  assert.match(sql, /AFTER INSERT OR UPDATE OF transaction_hash, block_number/);
  assert.match(sql, /idx_rh_fresh_wallet_queue_claim[\s\S]*WHERE status = 'pending'/);
  assert.match(sql, /GET DIAGNOSTICS queued_count = ROW_COUNT/);
  assert.doesNotMatch(sql, /eth_get|RH_NODE_RPC_URL|ROBINHOOD_RPC_URL/);
  assert.equal(group.repair, 'node src/utils/db-init-stage178.js');
});

it('registers terminal FRESH shadow evidence without a public classifier state', () => {
  const sql = stage179.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage179-robinhood-fresh-wallet-shadow'
  ));
  assert.match(sql, /status IN \('pending', 'ready', 'unavailable', 'stale', 'reorged'\)/);
  assert.match(sql, /outcome IN \('fresh', 'not_fresh'\)/);
  assert.match(sql, /REFERENCES robinhood_fresh_wallet_queue/);
  assert.doesNotMatch(sql, /robinhood_holder_classification_states/);
  assert.equal(group.repair, 'node src/utils/db-init-stage179.js');
});

it('indexes the FRESH cohort window and every wallet-swap partition safely', () => {
  const sql = stage185.STATEMENTS.join('\n');
  const { childIndexSql, attachIndexSql } = stage185.__private;
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage185-robinhood-fresh-seed-indexes'
  ));
  assert.match(sql, /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rh_launch_anchors_fresh_seed_window/);
  assert.match(sql, /chain, launch_block_time, token_address/);
  assert.match(sql, /INCLUDE \(first_pool_block\)/);
  assert.match(sql, /ON ONLY robinhood_wallet_swaps\(chain, token_address, block_number\)/);
  assert.match(childIndexSql('public', 'robinhood_wallet_swaps_2026_08_30'),
    /CREATE INDEX CONCURRENTLY[\s\S]+chain, token_address, block_number/);
  assert.match(attachIndexSql('public', 'robinhood_wallet_swaps_2026_08_30'),
    /ALTER INDEX[\s\S]+ATTACH PARTITION/);
  assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN|CONSTRAINT)/i);
  assert.equal(group.repair, 'node src/utils/db-init-stage185.js');
  assert.deepEqual(group.tables.flatMap(({ indexes }) => indexes.map(({ name }) => name)), [
    'idx_rh_launch_anchors_fresh_seed_window',
    'idx_rh_wallet_swaps_token_block',
  ]);
});

it('resumes interrupted concurrent index builds and skips attached partitions', async () => {
  const calls = [];
  const database = { async query(sql, params = []) {
    calls.push({ sql, params });
    if (sql.includes('FROM pg_inherits table_tree')) return { rows: [{
      schema_name: 'public', partition_name: 'robinhood_wallet_swaps_2026_08_29',
      attached: false,
    }, {
      schema_name: 'public', partition_name: 'robinhood_wallet_swaps_2026_08_30',
      attached: true,
    }] };
    if (sql.includes('to_regclass($1)')) {
      return { rows: [{ indisvalid: !params[0].includes('launch_anchors') }] };
    }
    if (sql.includes('index_state.indexrelid = $1::regclass')) {
      return { rows: [{ indisvalid: true }] };
    }
    return { rows: [] };
  } };

  await stage185.init({ database, closePool: false });

  assert.equal(calls.filter(({ sql }) => sql.startsWith('DROP INDEX CONCURRENTLY')).length, 1);
  assert.equal(calls.filter(({ sql }) => (
    sql.startsWith('CREATE INDEX CONCURRENTLY') && sql.includes('wallet_swaps_2026_08_29')
  )).length, 1);
  assert.equal(calls.filter(({ sql }) => sql.includes('ATTACH PARTITION')).length, 1);
  assert.equal(calls.some(({ sql }) => (
    sql.startsWith('CREATE INDEX CONCURRENTLY') && sql.includes('wallet_swaps_2026_08_30')
  )), false);
});
