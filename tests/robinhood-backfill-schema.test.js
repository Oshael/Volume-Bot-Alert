const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage82 = require('../src/utils/db-init-stage82');
const stage83 = require('../src/utils/db-init-stage83');
const stage200 = require('../src/utils/db-init-stage200');
const { SCHEMA_GROUPS, getGroupsForProfile } = require('../src/utils/runtime-schema');

describe('Robinhood durable backfill capture schema', () => {
  it('creates range manifests with ordered completion and retry contracts', () => {
    const sql = stage82.STATEMENTS.join('\n');

    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_backfill_ranges/);
    assert.match(sql, /UNIQUE \(chain, stream, from_block, to_block\)/);
    assert.match(sql, /tracked_log_count <= raw_log_count/);
    assert.match(sql, /checkpoint_block = to_block/);
    assert.match(sql, /fetch_finished_at >= fetch_started_at/);
    assert.match(sql, /idx_robinhood_backfill_ranges_commit/);
    assert.match(sql, /idx_robinhood_backfill_ranges_retry/);
  });

  it('stores replayable raw logs with durable lease and terminal-state invariants', () => {
    const sql = stage82.STATEMENTS.join('\n');

    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_market_log_staging/);
    assert.match(sql, /PRIMARY KEY \(chain, transaction_hash, log_index\)/);
    assert.match(sql, /topics JSONB NOT NULL/);
    assert.match(sql, /data TEXT NOT NULL/);
    assert.match(sql, /FOREIGN KEY \(range_id\).*robinhood_backfill_ranges\(id\)/s);
    assert.match(sql, /enrichment_status = 'leased'/);
    assert.match(sql, /enrichment_status IN \('completed', 'rejected'\)/);
    assert.match(sql, /retention_eligible_at > terminal_at/);
    assert.doesNotMatch(sql, /expires_at/);
  });

  it('keeps scan and enrichment watermarks separate from legacy ingestion cursors', () => {
    const sql = stage82.STATEMENTS.join('\n');

    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_backfill_watermarks/);
    assert.match(sql, /'discovery_scan', 'market_scan', 'market_enriched'/);
    assert.match(sql, /checkpoint_block < next_block/);
    assert.doesNotMatch(sql, /ALTER TABLE robinhood_ingestion_cursors/);
    assert.doesNotMatch(sql, /UPDATE robinhood_ingestion_cursors/);
  });

  it('registers all tables and critical indexes in runtime and test schema guards', () => {
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage82-robinhood-durable-backfill-capture'
    ));

    assert.equal(group.repair, 'node src/utils/db-init-stage82.js');
    assert.deepEqual(group.tables.map(({ table }) => table), [
      'robinhood_backfill_ranges',
      'robinhood_market_log_staging',
      'robinhood_backfill_watermarks',
    ]);
    assert.deepEqual(group.tables[1].indexes.map(({ name }) => name), [
      'idx_robinhood_market_log_staging_claim',
      'idx_robinhood_market_log_staging_lease',
      'idx_robinhood_market_log_staging_range',
      'idx_robinhood_market_log_staging_retention',
    ]);
    assert.ok(getGroupsForProfile('test').includes(group));
  });

  it('adds a durable aggregation outbox without coupling it to live cursors', () => {
    const sql = stage83.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage83-robinhood-backfill-aggregation-outbox'
    ));

    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_backfill_aggregation_outbox/);
    assert.match(sql, /REFERENCES robinhood_market_observations/);
    assert.match(sql, /ON DELETE CASCADE/);
    assert.match(sql, /PRIMARY KEY \(chain, transaction_hash, log_index\)/);
    assert.match(sql, /idx_robinhood_backfill_aggregation_outbox_claim/);
    assert.match(sql, /idx_robinhood_backfill_aggregation_outbox_bucket/);
    assert.doesNotMatch(sql, /robinhood_ingestion_cursors/);
    assert.equal(group.repair, 'node src/utils/db-init-stage83.js');
    assert.ok(getGroupsForProfile('test').includes(group));
  });

  it('makes raw retention cascades safe and tunes autovacuum for churn', () => {
    const sql = stage200.STATEMENTS.join('\n');

    assert.match(sql, /robinhood_backfill_aggregation_outbox_observation_fkey/);
    assert.match(sql, /ON DELETE CASCADE NOT VALID/);
    assert.match(sql, /ALTER TABLE robinhood_market_observations SET/);
    assert.match(sql, /ALTER TABLE robinhood_processed_logs SET/);
    assert.match(sql, /autovacuum_vacuum_scale_factor = 0\.005/);
  });
});
