const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const db = require('../src/models/db');
const stage51 = require('../src/utils/db-init-stage51');
const stage52 = require('../src/utils/db-init-stage52');
const stage53 = require('../src/utils/db-init-stage53');
const stage54 = require('../src/utils/db-init-stage54');
const stage55 = require('../src/utils/db-init-stage55');
const stage56 = require('../src/utils/db-init-stage56');
const stage57 = require('../src/utils/db-init-stage57');
const stage58 = require('../src/utils/db-init-stage58');
const stage59 = require('../src/utils/db-init-stage59');
const stage60 = require('../src/utils/db-init-stage60');
const stage61 = require('../src/utils/db-init-stage61');
const stage62 = require('../src/utils/db-init-stage62');
const stage63 = require('../src/utils/db-init-stage63');
const stage64 = require('../src/utils/db-init-stage64');
const stage65 = require('../src/utils/db-init-stage65');
const stage66 = require('../src/utils/db-init-stage66');
const stage67 = require('../src/utils/db-init-stage67');
const stage68 = require('../src/utils/db-init-stage68');
const stage69 = require('../src/utils/db-init-stage69');
const stage70 = require('../src/utils/db-init-stage70');
const stage71 = require('../src/utils/db-init-stage71');
const stage72 = require('../src/utils/db-init-stage72');
const stage74 = require('../src/utils/db-init-stage74');
const stage78 = require('../src/utils/db-init-stage78');
const stage79 = require('../src/utils/db-init-stage79');
const stage81 = require('../src/utils/db-init-stage81');
const stage90 = require('../src/utils/db-init-stage90');
const stage91 = require('../src/utils/db-init-stage91');
const stage92 = require('../src/utils/db-init-stage92');
const stage98 = require('../src/utils/db-init-stage98');
const stage99 = require('../src/utils/db-init-stage99');
const stage102 = require('../src/utils/db-init-stage102');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood additive chain schema', () => {
  it('adds chain identity to generic market tables with a Solana-safe backfill', () => {
    assert.deepEqual(stage51.CHAIN_TABLES, [
      'token_market_buckets_1m',
      'token_market_volume_buckets_1m',
      'token_market_buckets_agg',
    ]);
    const sql = stage51.STATEMENTS.join('\n');

    for (const table of stage51.CHAIN_TABLES) assert.match(sql, new RegExp(table));
    assert.match(sql, /SET chain = ''solana'' WHERE chain IS NULL/);
    assert.match(sql, /NOT NULL DEFAULT ''solana''/);
    assert.match(sql, /ALTER COLUMN chain SET DEFAULT ''solana''/);
    assert.match(sql, /ALTER COLUMN chain SET NOT NULL/);
    assert.match(sql, /INDEX CONCURRENTLY/);
  });

  it('prepares composite identities without removing legacy constraints', () => {
    const sql = stage51.STATEMENTS.join('\n');

    assert.match(sql, /token_catalog\(chain, address\)/);
    assert.match(sql, /token_market_buckets_1m\(chain, token_address, bucket_ts\)/);
    assert.match(sql, /token_market_volume_buckets_1m\(chain, token_address, bucket_ts\)/);
    assert.match(sql, /token_market_buckets_agg\(chain, token_address, granularity_minutes, bucket_ts\)/);
    assert.equal((sql.match(/WHERE chain <> 'solana'/g) || []).length, 3);
    assert.doesNotMatch(sql, /chain_lookup/);
    assert.doesNotMatch(sql, /DROP\s+(?:CONSTRAINT|INDEX|COLUMN|TABLE)/i);
  });

  it('adds Solana-backfilled chain columns to user, risk, and alert identities', () => {
    const sql = stage52.STATEMENTS.join('\n');

    assert.equal(stage52.CHAIN_TABLES.length, 16);
    for (const table of stage52.CHAIN_TABLES) assert.match(sql, new RegExp(table));
    assert.match(sql, /UPDATE %I SET chain = ''solana'' WHERE chain IS NULL/);
    assert.match(sql, /ALTER COLUMN chain SET DEFAULT ''solana''/);
    assert.match(sql, /ALTER COLUMN chain SET NOT NULL/);
    assert.match(sql, /INDEX CONCURRENTLY/);
  });

  it('prepares user and alert composite indexes while retaining old keys', () => {
    const sql = stage52.STATEMENTS.join('\n');

    assert.match(sql, /user_tokens\(user_id, chain, address\)/);
    assert.match(sql, /user_token_folder_items\(user_id, folder_id, chain, address\)/);
    assert.match(sql, /user_alert_rule_state\(user_id, rule_key, chain, token_address\)/);
    assert.match(sql, /admin_token_review_alerts\(chain, token_address, alert_kind\)/);
    assert.match(sql, /to_regclass\('admin_blocked_tokens'\)/);
    assert.doesNotMatch(sql, /DROP\s+(?:CONSTRAINT|INDEX|COLUMN|TABLE)/i);
  });

  it('registers both additive stages in the runtime schema guard', () => {
    const stage51Group = SCHEMA_GROUPS.find((group) => group.key === 'stage51-chain-aware-catalog-market');
    const stage52Group = SCHEMA_GROUPS.find((group) => group.key === 'stage52-chain-aware-user-risk-alerts');

    assert.equal(stage51Group.repair, 'node src/utils/db-init-stage51.js');
    assert.equal(stage52Group.repair, 'node src/utils/db-init-stage52.js');
    assert.equal(stage51Group.tables.find((table) => table.table === 'token_market_buckets_1m').defaults.chain,
      "'solana'::character varying");
    assert.equal(stage52Group.tables.find((table) => table.table === 'user_tokens').defaults.chain,
      "'solana'::character varying");
  });

  it('promotes the catalog identity to chain plus address', () => {
    const sql = stage53.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => entry.key === 'stage53-token-catalog-composite-identity');

    assert.match(sql, /UNIQUE USING INDEX idx_token_catalog_chain_address_unique/);
    assert.match(sql, /DROP CONSTRAINT IF EXISTS token_catalog_address_key/);
    assert.equal(group.repair, 'node src/utils/db-init-stage53.js');
    assert.deepEqual(group.tables[0].constraints[0].includes, ['UNIQUE', 'chain', 'address']);
  });

  it('promotes user preferences and folder membership to chain-aware identities', () => {
    const sql = stage54.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => entry.key === 'stage54-chain-aware-user-token-preferences');

    assert.match(sql, /user_tokens_user_chain_address_key/);
    assert.match(sql, /FOREIGN KEY \(user_id, chain, address\)/);
    assert.match(sql, /DROP CONSTRAINT IF EXISTS user_tokens_user_id_address_key/);
    assert.match(sql, /PRIMARY KEY USING INDEX idx_user_token_folder_items_chain_identity/);
    assert.equal(group.repair, 'node src/utils/db-init-stage54.js');
    assert.equal(group.tables.length, 5);
  });

  it('promotes user and admin block identities without global address bans', () => {
    const sql = stage55.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => entry.key === 'stage55-chain-aware-blocklists-evidence');

    assert.match(sql, /CREATE TABLE IF NOT EXISTS admin_blocked_tokens/);
    assert.match(sql, /user_blocklist_user_chain_address_key/);
    assert.match(sql, /admin_blocked_tokens_chain_pkey/);
    assert.match(sql, /DROP CONSTRAINT IF EXISTS admin_blocked_tokens_pkey/);
    assert.match(sql, /admin_block_evidence\(chain, token_address/);
    assert.equal(group.repair, 'node src/utils/db-init-stage55.js');
    assert.equal(group.tables.length, 3);
  });

  it('promotes risk storage identity without enabling Robinhood classification', () => {
    const sql = stage56.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => entry.key === 'stage56-chain-aware-risk-storage');

    assert.match(sql, /token_risk_enrichment_chain_pkey/);
    assert.match(sql, /token_risk_reviews_chain_pkey/);
    assert.match(sql, /token_junk_evidence_chain_key/);
    assert.match(sql, /DROP CONSTRAINT IF EXISTS token_risk_reviews_pkey/);
    assert.equal(group.repair, 'node src/utils/db-init-stage56.js');
    assert.equal(group.tables.length, 3);
  });

  it('promotes alert state and event dedupe without enabling Robinhood triggers', () => {
    const sql = stage57.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => entry.key === 'stage57-chain-aware-alert-identity');

    assert.match(sql, /user_alert_rule_state_chain_pkey/);
    assert.match(sql, /user_alert_events_user_chain_dedupe_key/);
    assert.match(sql, /DROP CONSTRAINT IF EXISTS user_alert_rule_state_pkey/);
    assert.match(sql, /DROP CONSTRAINT IF EXISTS user_alert_events_user_id_dedupe_key_key/);
    assert.equal(group.repair, 'node src/utils/db-init-stage57.js');
    assert.equal(group.tables.length, 2);
  });

  it('uses chain-aware indexes for custom, admin, and exit alert storage', () => {
    const sql = stage58.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => entry.key === 'stage58-chain-aware-custom-admin-exit-alerts');

    assert.match(sql, /user_custom_alert_rules\(chain, token_address/);
    assert.match(sql, /admin_token_review_alerts\(chain, token_address, alert_kind\)/);
    assert.match(sql, /monitored_token_exit_events\(chain, token_address/);
    assert.match(sql, /DROP INDEX IF EXISTS idx_admin_token_review_alerts_open_token_kind/);
    assert.equal(group.repair, 'node src/utils/db-init-stage58.js');
    assert.equal(group.tables.length, 3);
  });

  it('promotes minute volume buckets to a chain-aware primary key', () => {
    const sql = stage59.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => entry.key === 'stage59-chain-aware-minute-volume-buckets');

    assert.match(sql, /token_market_volume_buckets_1m_chain_pkey/);
    assert.match(sql, /PRIMARY KEY USING INDEX idx_token_market_volume_buckets_1m_chain_identity_full/);
    assert.match(sql, /CREATE UNIQUE INDEX CONCURRENTLY/);
    assert.match(sql, /CREATE INDEX CONCURRENTLY/);
    assert.match(sql, /DROP CONSTRAINT IF EXISTS token_market_volume_buckets_1m_pkey/);
    assert.match(sql, /DROP INDEX CONCURRENTLY IF EXISTS idx_token_market_volume_buckets_1m_addr_bucket_ts/);
    assert.match(sql, /DROP INDEX CONCURRENTLY IF EXISTS idx_token_market_volume_buckets_1m_chain_identity/);
    assert.equal(group.repair, 'node src/utils/db-init-stage59.js');
    assert.equal(group.tables.length, 1);
  });

  it('promotes minute OHLC buckets without enabling unsafe Robinhood writes', () => {
    const sql = stage60.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => entry.key === 'stage60-chain-aware-minute-ohlc-buckets');

    assert.match(sql, /token_market_buckets_1m_chain_pkey/);
    assert.match(sql, /PRIMARY KEY USING INDEX idx_token_market_buckets_1m_chain_identity_full/);
    assert.match(sql, /CREATE UNIQUE INDEX CONCURRENTLY/);
    assert.match(sql, /DROP CONSTRAINT IF EXISTS token_market_buckets_1m_pkey/);
    assert.match(sql, /DROP INDEX CONCURRENTLY IF EXISTS idx_token_market_buckets_1m_addr_bucket_ts/);
    assert.match(sql, /DROP INDEX CONCURRENTLY IF EXISTS idx_token_market_buckets_1m_chain_identity/);
    assert.equal(group.repair, 'node src/utils/db-init-stage60.js');
    assert.equal(group.tables.length, 1);
  });

  it('replaces the address-only OHLC sparkline index with a chain-aware cover', () => {
    const sql = stage61.STATEMENTS.join('\n');

    assert.match(sql, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
    assert.match(sql, /token_market_buckets_1m\(chain, token_address, bucket_ts DESC\)/);
    assert.match(sql, /INCLUDE \(pair_address, close_mcap\)/);
    assert.match(sql, /DROP INDEX CONCURRENTLY IF EXISTS idx_token_market_buckets_1m_sparkline_cover/);
  });

  it('promotes aggregate OHLC buckets and their lookup indexes to chain-aware identity', () => {
    const sql = stage62.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => entry.key === 'stage62-chain-aware-aggregate-ohlc-buckets');

    assert.match(sql, /token_market_buckets_agg_chain_pkey/);
    assert.match(sql, /PRIMARY KEY USING INDEX idx_token_market_buckets_agg_chain_identity_full/);
    assert.match(sql, /CREATE UNIQUE INDEX CONCURRENTLY/);
    assert.match(sql, /token_market_buckets_agg\(chain, token_address, granularity_minutes, bucket_ts DESC\)/);
    assert.match(sql, /token_market_buckets_agg\(chain, granularity_minutes, bucket_ts DESC\)/);
    assert.match(sql, /DROP CONSTRAINT IF EXISTS token_market_buckets_agg_pkey/);
    assert.match(sql, /DROP INDEX CONCURRENTLY IF EXISTS idx_token_market_buckets_agg_lookup/);
    assert.match(sql, /DROP INDEX CONCURRENTLY IF EXISTS idx_token_market_buckets_agg_bucket_ts/);
    assert.equal(group.repair, 'node src/utils/db-init-stage62.js');
    assert.equal(group.tables.length, 1);
  });

  it('removes an interrupted Stage 62 index so a rerun can rebuild it', async () => {
    const originalQuery = db.query;
    const calls = [];
    db.query = async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM pg_index/.test(sql)) return { rows: [{ indisvalid: false }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };

    try {
      const removed = await stage62.removeInvalidIndex('idx_token_market_buckets_agg_chain_lookup');
      assert.equal(removed, true);
      assert.deepEqual(calls[0].params, ['idx_token_market_buckets_agg_chain_lookup']);
      assert.match(calls[1].sql,
        /DROP INDEX CONCURRENTLY IF EXISTS idx_token_market_buckets_agg_chain_lookup/);
    } finally {
      db.query = originalQuery;
    }
  });

  it('creates a compact Robinhood registry, cursor, and three-day dedupe ledger', () => {
    const sql = stage63.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage63-robinhood-persistence-control-plane'
    ));

    assert.equal(stage63.PROCESSED_LOG_RETENTION_DAYS, 3);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_pool_registry/);
    assert.match(sql, /PRIMARY KEY \(chain, protocol, market_key\)/);
    assert.match(sql, /protocol = 'uniswap-v4' AND pool_id IS NOT NULL AND pool_address IS NULL/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS origin_address/);
    assert.match(sql, /SET origin_address = manager_address/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_ingestion_cursors/);
    assert.match(sql, /stream IN \('discovery', 'market'\)/);
    assert.match(sql, /CHECK \(\(checkpoint_block IS NULL\) = \(checkpoint_hash IS NULL\)\)/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_processed_logs/);
    assert.match(sql, /PRIMARY KEY \(chain, transaction_hash, log_index\)/);
    assert.match(sql, /DEFAULT NOW\(\) \+ INTERVAL '3 days'/);
    assert.doesNotMatch(sql, /raw_(?:log|payload)|payload JSONB/);
    assert.equal(group.repair, 'node src/utils/db-init-stage63.js');
    assert.equal(group.tables.length, 3);
  });

  it('creates exact three-day Robinhood observations without bounded decimal precision', () => {
    const sql = stage64.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => entry.key === 'stage64-robinhood-market-observations');

    assert.equal(stage64.OBSERVATION_RETENTION_DAYS, 3);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_market_observations/);
    assert.match(sql, /token_amount_raw NUMERIC\(78, 0\)/);
    assert.match(sql, /price_usd NUMERIC/);
    assert.doesNotMatch(sql, /price_usd NUMERIC\([^)]/);
    assert.match(sql, /status IN \('pending', 'accepted', 'rejected'\)/);
    assert.match(sql, /status <> 'accepted' OR/);
    assert.match(sql, /token_amount_raw > 0 AND quote_amount_raw > 0/);
    assert.match(sql, /FOREIGN KEY \(chain, transaction_hash, log_index\)/);
    assert.match(sql, /REFERENCES robinhood_processed_logs/);
    assert.match(sql, /ON DELETE CASCADE/);
    assert.match(sql, /DEFAULT NOW\(\) \+ INTERVAL '3 days'/);
    assert.doesNotMatch(sql, /payload|raw_log/);
    assert.equal(group.repair, 'node src/utils/db-init-stage64.js');
    assert.equal(group.tables.length, 1);
  });

  it('creates deterministic 14-day Robinhood one-minute OHLCV buckets', () => {
    const sql = stage65.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage65-robinhood-market-buckets-1m'
    ));

    assert.equal(stage65.BUCKET_RETENTION_DAYS, 14);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_market_buckets_1m/);
    assert.match(sql, /PRIMARY KEY \(chain, protocol, market_key, bucket_ts\)/);
    assert.match(sql, /open_price_usd NUMERIC NOT NULL/);
    assert.match(sql, /close_fdv_usd NUMERIC NOT NULL/);
    assert.match(sql, /first_block_number BIGINT NOT NULL/);
    assert.match(sql, /last_block_number BIGINT NOT NULL/);
    assert.match(sql, /buys \+ sells = swaps/);
    assert.match(sql, /transactions > 0 AND transactions <= swaps/);
    assert.match(sql, /idx_robinhood_market_buckets_1m_expiry/);
    assert.equal(group.repair, 'node src/utils/db-init-stage65.js');
    assert.equal(group.tables.length, 1);
  });

  it('creates permanent UTC-aligned Robinhood one-hour OHLCV buckets', () => {
    const sql = stage66.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage66-robinhood-market-buckets-1h'
    ));

    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_market_buckets_1h/);
    assert.match(sql, /PRIMARY KEY \(chain, protocol, market_key, bucket_ts\)/);
    assert.match(sql, /date_trunc\('hour', bucket_ts AT TIME ZONE 'UTC'\)/);
    assert.match(sql, /source_minute_buckets BETWEEN 1 AND 60/);
    assert.doesNotMatch(sql, /expires_at/);
    assert.equal(group.repair, 'node src/utils/db-init-stage66.js');
    assert.equal(group.tables.length, 1);
  });

  it('creates and guards token-level Robinhood aggregate buckets', () => {
    const sql = stage78.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage78-robinhood-market-buckets-agg'
    ));

    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_market_buckets_agg/);
    assert.match(sql, /PRIMARY KEY \(chain, token_address, granularity_minutes, bucket_ts\)/);
    assert.match(sql, /granularity_minutes IN \(5, 15, 30, 60, 240, 1440\)/);
    assert.match(sql, /high_price_usd >= GREATEST\(open_price_usd, close_price_usd\)/);
    assert.match(sql, /idx_robinhood_market_buckets_agg_token_range/);
    assert.match(sql, /idx_robinhood_market_buckets_agg_cleanup/);
    assert.equal(group.repair, 'node src/utils/db-init-stage78.js');
    assert.deepEqual(group.tables[0].indexes.map((index) => index.name), [
      'idx_robinhood_market_buckets_agg_token_range',
      'idx_robinhood_market_buckets_agg_cleanup',
    ]);
  });

  it('records historical supply provenance without relabeling FDV as market cap', () => {
    const sql = stage79.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage79-robinhood-supply-provenance'
    ));

    assert.match(sql, /ADD COLUMN IF NOT EXISTS token_supply_status/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS token_supply_anchor_block_number/);
    assert.match(sql, /reconstructed_mint_burn/);
    assert.match(sql, /token_supply_anchor_block_number <= block_number/);
    assert.match(sql, /NOT VALID/);
    assert.doesNotMatch(sql, /UPDATE robinhood_market_observations/);
    assert.doesNotMatch(sql, /market_cap_usd\s*=/);
    assert.equal(group.repair, 'node src/utils/db-init-stage79.js');
    assert.deepEqual(group.tables[0].columns, [
      'token_supply_status', 'token_supply_anchor_block_number',
    ]);
  });

  it('aligns shared catalog price precision with unbounded Robinhood buckets', () => {
    const sql = stage81.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage81-token-catalog-price-precision'
    ));

    assert.match(sql, /ALTER COLUMN last_price TYPE NUMERIC/);
    assert.doesNotMatch(sql, /NUMERIC\s*\(/);
    assert.equal(group.repair, 'node src/utils/db-init-stage81.js');
    assert.deepEqual(group.tables[0].columnTypes.last_price, {
      dataType: 'numeric',
      numericPrecision: null,
      numericScale: null,
    });
  });

  it('adds protocol-safe liquidity evidence to exact Robinhood observations', () => {
    const sql = stage67.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage67-robinhood-observation-liquidity'
    ));

    assert.match(sql, /ALTER TABLE robinhood_market_observations/);
    assert.match(sql, /liquidity_usd NUMERIC/);
    assert.match(sql, /liquidity_raw NUMERIC\(78, 0\)/);
    assert.match(sql, /robinhood_market_observations_liquidity_values_check/);
    assert.match(sql, /protocol = 'uniswap-v2' AND liquidity_raw IS NULL/);
    assert.match(sql, /protocol IN \('uniswap-v3', 'uniswap-v4'\) AND liquidity_usd IS NULL/);
    assert.doesNotMatch(sql, /DROP\s+(?:COLUMN|TABLE)/i);
    assert.equal(group.repair, 'node src/utils/db-init-stage67.js');
    assert.deepEqual(group.tables[0].columns, [
      'liquidity_usd', 'liquidity_raw', 'liquidity_status',
      'liquidity_confidence', 'liquidity_warning',
    ]);
  });

  it('adds nullable last-liquidity snapshots to minute and hourly buckets', () => {
    const sql = stage68.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage68-robinhood-bucket-liquidity'
    ));

    assert.deepEqual(stage68.BUCKET_TABLES, [
      'robinhood_market_buckets_1m',
      'robinhood_market_buckets_1h',
    ]);
    assert.equal((sql.match(/ADD COLUMN IF NOT EXISTS close_liquidity_usd/g) || []).length, 2);
    assert.match(sql, /spot_estimate_from_double_quote_reserve/);
    assert.match(sql, /requires_tick_liquidity_distribution/);
    assert.match(sql, /close_liquidity_raw >= 0/);
    assert.doesNotMatch(sql, /NOT NULL|DROP\s+(?:COLUMN|TABLE)/i);
    assert.equal(group.repair, 'node src/utils/db-init-stage68.js');
    assert.equal(group.tables.length, 2);
  });

  it('allows V3 pool-balance TVL while keeping V4 fail-closed', () => {
    const sql = stage98.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage98-robinhood-v3-pool-balance-tvl'
    ));

    assert.equal(stage98.TABLES.length, 3);
    assert.match(sql, /spot_tvl_from_pool_balances/);
    assert.match(sql, /protocol = 'uniswap-v4'/);
    assert.match(sql, /requires_tick_liquidity_distribution/);
    assert.equal(group.repair, 'node src/utils/db-init-stage98.js');
    assert.equal(group.tables.length, 3);
  });

  it('creates the immutable V4 tick-range liquidity ledger', () => {
    const sql = stage99.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage99-robinhood-v4-liquidity-ledger'
    ));

    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_v4_liquidity_deltas/);
    assert.match(sql, /liquidity_delta NUMERIC\(78, 0\) NOT NULL/);
    assert.doesNotMatch(sql, /REFERENCES robinhood_processed_logs/);
    assert.match(sql, /DROP CONSTRAINT IF EXISTS robinhood_v4_liquidity_deltas_log_fkey/);
    assert.match(sql, /tick_lower < tick_upper/);
    assert.match(sql, /pool_id, tick_lower, tick_upper, block_number, log_index/);
    assert.equal(group.repair, 'node src/utils/db-init-stage99.js');
  });

  it('allows V4 point-in-time tick-range TVL', () => {
    const sql = stage102.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => entry.key === 'stage102-robinhood-v4-tick-range-tvl');

    assert.match(sql, /spot_tvl_from_v4_tick_ranges/);
    assert.match(sql, /protocol = 'uniswap-v4'/);
    assert.equal(group.repair, 'node src/utils/db-init-stage102.js');
    assert.equal(group.tables.length, 3);
  });

  it('stores FDV separately from market cap in the shared catalog', () => {
    const sql = stage69.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => entry.key === 'stage69-token-catalog-fdv');

    assert.match(sql, /ADD COLUMN IF NOT EXISTS last_fdv NUMERIC/);
    assert.doesNotMatch(sql, /last_mcap/);
    assert.equal(group.repair, 'node src/utils/db-init-stage69.js');
    assert.deepEqual(group.tables[0].columns, ['last_fdv']);
  });

  it('adds concurrent global time indexes without indexing mutable metrics', () => {
    const sql = stage70.STATEMENTS.join('\n');

    assert.deepEqual(stage70.INDEXES.map(({ name, table }) => [name, table]), [
      ['idx_robinhood_market_buckets_1m_global_time', 'robinhood_market_buckets_1m'],
      ['idx_robinhood_market_buckets_1h_global_time', 'robinhood_market_buckets_1h'],
    ]);
    assert.equal((sql.match(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/g) || []).length, 2);
    assert.equal((sql.match(/\(chain, bucket_ts DESC, token_address, protocol, market_key\)/g) || []).length, 2);
    assert.doesNotMatch(sql, /INCLUDE|volume_usd|price_usd|liquidity/);
  });

  it('stores project websites separately from trading pair URLs', () => {
    const sql = stage71.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage71-token-catalog-website'
    ));

    assert.match(sql, /ADD COLUMN IF NOT EXISTS last_website_url TEXT/);
    assert.doesNotMatch(sql, /last_pair_url|DROP\s+(?:COLUMN|TABLE)/i);
    assert.equal(group.repair, 'node src/utils/db-init-stage71.js');
    assert.deepEqual(group.tables[0].columns, ['last_website_url']);
  });

  it('persists successful and negative Robinhood metadata source checks', () => {
    const sql = stage72.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage72-robinhood-metadata-source-checks'
    ));

    assert.match(sql, /robinhood_blockscout_checked_at TIMESTAMPTZ/);
    assert.match(sql, /robinhood_dexscreener_checked_at TIMESTAMPTZ/);
    assert.doesNotMatch(sql, /DROP\s+(?:COLUMN|TABLE)/i);
    assert.equal(group.repair, 'node src/utils/db-init-stage72.js');
  });

  it('persists a conservative Robinhood continuous-coverage origin', () => {
    const sql = stage74.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage74-robinhood-coverage-origin'
    ));

    assert.match(sql, /ADD COLUMN IF NOT EXISTS coverage_start_block BIGINT/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS coverage_start_timestamp TIMESTAMPTZ/);
    assert.match(sql, /coverage_start_block = COALESCE\(coverage_start_block, checkpoint_block\)/);
    assert.match(sql, /coverage_start_timestamp = COALESCE\(coverage_start_timestamp, checkpoint_timestamp\)/);
    assert.match(sql, /coverage_start_block <= checkpoint_block/);
    assert.match(sql, /coverage_start_timestamp <= checkpoint_timestamp/);
    assert.doesNotMatch(sql, /created_at|DROP\s+(?:COLUMN|TABLE)/i);
    assert.equal(group.repair, 'node src/utils/db-init-stage74.js');
    assert.deepEqual(group.tables[0].columns, [
      'coverage_start_block', 'coverage_start_timestamp',
    ]);
  });

  it('creates a partitioned wallet-attributed swap table keyed by the signing EOA', () => {
    const sql = stage90.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => entry.key === 'stage90-robinhood-wallet-swaps');

    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_wallet_swaps/);
    // Daily partitioning by onchain time, per the 30-day retention plan.
    assert.match(sql, /PARTITION BY RANGE \(block_time\)/);
    // Partition key must be inside the identity; wallet stays a NOT NULL column.
    assert.match(sql, /PRIMARY KEY \(chain, transaction_hash, action_index, block_time\)/);
    assert.match(sql, /wallet_address VARCHAR\(42\) NOT NULL/);
    assert.match(sql, /wallet_address ~ '\^0x\[0-9a-f\]\{40\}\$'/);
    assert.match(sql, /token_amount_raw NUMERIC\(78, 0\) NOT NULL/);
    assert.doesNotMatch(sql, /price_usd NUMERIC\([^)]/);
    assert.match(sql, /side IN \('buy', 'sell'\)/);
    // Foundation only: no partitions, no writer, no destructive statements.
    assert.doesNotMatch(sql, /PARTITION OF|CREATE PARTITION|DROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX)/i);
    assert.equal(group.repair, 'node src/utils/db-init-stage90.js');
    assert.deepEqual(group.tables[0].indexes.map((index) => index.name), [
      'idx_robinhood_wallet_swaps_wallet_time',
      'idx_robinhood_wallet_swaps_token_time',
      'idx_robinhood_wallet_swaps_chain_time',
    ]);
  });

  it('creates independent seed/live cursors for wallet attribution', () => {
    const sql = stage91.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => entry.key === 'stage91-robinhood-wallet-swap-cursors');

    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_wallet_swap_cursors/);
    assert.match(sql, /PRIMARY KEY \(chain, stream\)/);
    assert.match(sql, /stream IN \('seed', 'live'\)/);
    assert.match(sql, /\(checkpoint_block IS NULL\) = \(checkpoint_hash IS NULL\)/);
    assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX)/i);
    assert.equal(group.repair, 'node src/utils/db-init-stage91.js');
    assert.equal(group.tables.length, 1);
  });

  it('adds a concurrent by-block attribution index over accepted observations', () => {
    const sql = stage92.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => entry.key === 'stage92-robinhood-observation-attribution-index');

    assert.match(sql, /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_robinhood_market_observations_attribution/);
    assert.match(sql, /robinhood_market_observations \(chain, status, block_number, log_index\)/);
    assert.equal(group.repair, 'node src/utils/db-init-stage92.js');
    assert.deepEqual(group.tables[0].indexes.map((index) => index.name), [
      'idx_robinhood_market_observations_attribution',
    ]);
  });

  it('drops an interrupted invalid attribution index before rebuilding', async () => {
    const originalQuery = db.query;
    const calls = [];
    db.query = async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM pg_index/.test(sql)) return { rows: [{ indisvalid: false }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    try {
      const removed = await stage92.removeInvalidIndex();
      assert.equal(removed, true);
      assert.deepEqual(calls[0].params, ['idx_robinhood_market_observations_attribution']);
      assert.match(calls[1].sql, /DROP INDEX CONCURRENTLY IF EXISTS idx_robinhood_market_observations_attribution/);
    } finally {
      db.query = originalQuery;
    }
  });
});
