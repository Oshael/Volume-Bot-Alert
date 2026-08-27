const assert = require('node:assert/strict');
const { test } = require('node:test');

const stage169 = require('../src/utils/db-init-stage169');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

test('adds permanent token-scoped causal funding evidence', () => {
  const sql = stage169.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage169-robinhood-token-scoped-funding-evidence'
  ));
  assert.match(sql, /robinhood_bundle_funding_evidence/);
  assert.match(sql, /run_id, token_address, candidate_wallet/);
  assert.match(sql, /hop = 1 AND to_wallet = candidate_wallet/);
  assert.match(sql, /hop = 2/);
  assert.match(sql, /value_wei > 0/);
  assert.match(sql, /ALTER COLUMN evidence_version SET DEFAULT 'rh_native_funding_v2'/);
  assert.match(sql, /ALTER TABLE robinhood_bundle_funding_backfill_runs/);
  assert.doesNotMatch(sql, /INSERT INTO|\bUPDATE\b|DELETE FROM/i);
  assert.equal(group.repair, 'node src/utils/db-init-stage169.js');
  assert.equal(group.tables[0].defaults.evidence_version,
    "'rh_native_funding_v2'::character varying");
  const runTable = SCHEMA_GROUPS.flatMap(({ tables }) => tables).find(({ table }) => (
    table === 'robinhood_bundle_funding_backfill_runs'
  ));
  assert.equal(runTable.defaults.evidence_version, "'rh_native_funding_v2'::character varying");
});
