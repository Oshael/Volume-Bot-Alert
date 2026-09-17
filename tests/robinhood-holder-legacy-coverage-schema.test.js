'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const stage232 = require('../src/utils/db-init-stage232');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

it('defines an empty fail-closed legacy manifest and durable capture policy', () => {
  const sql = stage232.STATEMENTS.join('\n');
  for (const pattern of [
    /ADD COLUMN IF NOT EXISTS coverage_generation BIGINT NOT NULL DEFAULT 0/,
    /CREATE TABLE IF NOT EXISTS robinhood_holder_capture_policy/,
    /capture_mode IN \('legacy', 'tracked'\)/,
    /cutover_next_block = cutover_checkpoint_block \+ 1/,
    /CREATE TABLE IF NOT EXISTS robinhood_holder_legacy_coverage_manifest/,
    /coverage_generation > 0/,
    /baseline_status IN \('shadow', 'live'\)/,
    /baseline_backfill_next_block = baseline_deployment_block/,
    /OLD\.ledger_status IN \('shadow', 'live'\)/,
    /NEW\.coverage_generation := OLD\.coverage_generation \+ 1/,
  ]) assert.match(sql, pattern);
  assert.doesNotMatch(sql, /INSERT INTO robinhood_holder_legacy_coverage_manifest/);
  assert.match(sql, /INSERT INTO robinhood_holder_capture_policy \(chain\) VALUES \('robinhood'\)/);
  assert.doesNotMatch(sql, /INSERT INTO robinhood_holder_capture_policy \([^)]*capture_mode/);

  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage232-robinhood-holder-legacy-coverage'
  ));
  assert.equal(group.repair, 'node src/utils/db-init-stage232.js');
  assert.deepEqual(group.tables.map(({ table }) => table), [
    'robinhood_holder_token_states', stage232.POLICY_TABLE, stage232.MANIFEST_TABLE,
  ]);
});
